import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readUpload, runs, users, workflows, workflowVersions, workspaceMembers, type Db } from "@daloy/db";
import { StepError, type Step } from "@daloy/engine";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { createExecutor } from "./index";
import type { BrowserService } from "./browser";

// The worker's browser step against a fake browser service. apps/browser/src/service.test.ts tests the real one.
const key = randomBytes(32);
const TOKEN = "fake-browser-token-0123456789abcdef0123";
// The smallest valid PNG: a 1x1 transparent pixel.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let db: Db;
let pool: Pool;
let fake: Server;
let service: BrowserService;
let answer: { status: number; body: unknown } = { status: 200, body: {} };
const seen: { auth?: string; body?: unknown }[] = [];

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  service = { url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, token: TOKEN };
}, 120_000);
afterAll(async () => {
  fake?.close();
  await pool?.end();
});

async function setup(browser: BrowserService | null = service) {
  const [u] = await db.insert(users).values({ email: `browser-${randomUUID()}@test.local`, passwordHash: "x" }).returning();
  await db.insert(workspaceMembers).values({ userId: u!.id, workspaceId: u!.id, role: "owner" });
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Prices", slug: `p-${randomUUID().slice(0, 8)}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: { trigger: { type: "manual", config: {} }, steps: [], edges: [] }, published: true }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id }).returning();
  const exec = (step: Step, mock = false) =>
    createExecutor({ db, secretsKey: key, mail: {} as never, browser }).execute({
      runId: r!.id,
      stepRunId: "00000000-0000-0000-0000-000000000000",
      userId: u!.id,
      workflowId: wf!.id,
      step,
      attempt: 1,
      idempotencyKey: `${r!.id}:${step.id}`,
      mock,
      ctx: { trigger: { sku: "TOTE-1", name: "Ana Reyes" }, steps: {} },
    });
  return { userId: u!.id, runId: r!.id, exec };
}

const step = (actions: unknown[]): Step => ({ id: "look", type: "browser", config: { url: "https://supplier.example.com/item/{{trigger.sku}}", actions } }) as Step;
const fails = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as StepError);

describe("browser step", () => {
  it("fills templates, sends the token, keeps screenshots as uploads and puts extracted names in the output", async () => {
    answer = { status: 200, body: { url: "https://supplier.example.com/item/TOTE-1", extracted: { price: "PHP 1,250.00" }, screenshots: [PNG.toString("base64")], refused: [] } };
    const { exec, userId, runId } = await setup();
    const r = await exec(step([{ action: "fill", selector: "#q", value: "{{trigger.name}}" }, { action: "extract", selector: ".price", name: "price" }, { action: "screenshot" }]));
    const sent = seen.at(-1)!;
    expect(sent.auth).toBe(`Bearer ${TOKEN}`);
    expect(sent.body).toEqual({ url: "https://supplier.example.com/item/TOTE-1", actions: [{ action: "fill", selector: "#q", value: "Ana Reyes" }, { action: "extract", selector: ".price", name: "price" }, { action: "screenshot" }] });
    const out = r.output as { price: string; url: string; screenshots: { id: string; name: string; type: string; size: number }[] };
    expect(out).toMatchObject({ price: "PHP 1,250.00", url: "https://supplier.example.com/item/TOTE-1", screenshots: [{ name: "look-1.png", type: "png", size: PNG.length }] });
    const file = await readUpload(db, { userId, runId, id: out.screenshots[0]!.id });
    expect(file?.data.equals(PNG)).toBe(true);
  });

  it("returns would-do lines on a mocked test run and calls nothing", async () => {
    const before = seen.length;
    const { exec } = await setup();
    const r = await exec(step([{ action: "click", text: "Add to cart" }, { action: "extract", selector: ".price", name: "price" }]), true);
    expect(r.output).toEqual({
      mocked: true,
      url: "https://supplier.example.com/item/TOTE-1",
      wouldDo: ["Would open https://supplier.example.com/item/TOTE-1", 'Would click the element with the text "Add to cart"', "Would read .price into price"],
      screenshots: [],
      price: "",
    });
    expect(seen.length).toBe(before);
  });

  it("says plainly when the server has no browser service", async () => {
    const { exec } = await setup(null);
    const e = await fails(exec(step([])));
    expect(e?.message).toMatch(/not set up on this server/);
    expect(e?.retryable).toBe(false);
  });

  it("retries only what is safe to run twice", async () => {
    const { exec } = await setup();
    answer = { status: 503, body: { error: "The browser is busy. Try again in a minute." } };
    expect((await fails(exec(step([{ action: "click", text: "Order" }]))))?.retryable).toBe(true);
    answer = { status: 504, body: { error: "The page took longer than 60 seconds." } };
    expect((await fails(exec(step([{ action: "extract", selector: "h1", name: "h" }]))))?.retryable).toBe(true);
    const lost = await fails(exec(step([{ action: "click", text: "Order" }])));
    expect(lost?.retryable).toBe(false);
    expect(lost?.outcome).toBe("unknown");
    answer = { status: 422, body: { error: "This is a password field. The browser step never types a password." } };
    const e = await fails(exec(step([{ action: "fill", selector: "#pw", value: "x" }])));
    expect(e?.message).toMatch(/never types a password/);
    expect(e?.retryable).toBe(false);
  });

  it("refuses a screenshot that is not a PNG", async () => {
    answer = { status: 200, body: { url: "https://x.example.com/", extracted: {}, screenshots: [Buffer.from("<html>not an image</html>").toString("base64")] } };
    const { exec } = await setup();
    expect((await fails(exec(step([{ action: "screenshot" }]))))?.message).toMatch(/not a PNG/);
  });
});
