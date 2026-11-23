import { randomBytes, randomUUID } from "node:crypto";
import { connections, deliveries, runs, saveConnection, users, workflows, workflowVersions, workspaceMembers, type Db } from "@daloy/db";
import type { Step } from "@daloy/engine";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../../test/fake-providers";
import { startWorker, type Worker } from "../worker";
import { createExecutor } from "./index";

// The discord and google_docs steps (phase I1, decision 0104) against the fake Discord, Drive and Docs. No real request leaves this file.
const key = randomBytes(32);
const NO_STEP_RUN = "00000000-0000-0000-0000-000000000000";
const GOOGLE_USER = { id: "google-user-1", email: "ana@google.example" };
const ACCESS = "worker-test-access-token"; // synthetic, no provider prefix so secret scanners stay quiet
const TEMPLATE = "1TemplateDocIdAbCdEf";
const FOLDER = "1FolderIdForInvoicesAbC";
const BODY = "Invoice for {{name}}. Total {{total}}. Thanks, {{name}}.";
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let worker: Worker;
let hookUrl: string;
const HOOK_TOKEN = "fake-webhook-token-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  fake.addOAuthApp("google");
  fake.oauth.google!.accessTokens.set(ACCESS, GOOGLE_USER);
  hookUrl = fake.addDiscordWebhook();
  fake.addDocsTemplate(TEMPLATE, "Invoice template", BODY, [GOOGLE_USER.email]);
  fake.addDriveFolder(FOLDER, "Invoices", [GOOGLE_USER.email], null);
  worker = await startWorker({
    connectionString: url,
    db,
    executor: createExecutor({ db, secretsKey: key, mail: {} as never, urls: { ...fake.urls, timeoutMs: 2000 } }),
    deliveries: { secretsKey: key, urls: { ...fake.urls, timeoutMs: 2000 } },
    pollingIntervalSeconds: 0.5,
    sweepMs: 500,
  });
}, 120_000);
afterAll(async () => {
  await worker?.stop();
  await fake?.close();
  await pool?.end();
});

async function workspace(o: { discord?: boolean; google?: "oauth" | "service" | "failed" | "no-folder" | "none" } = {}) {
  const [u] = await db.insert(users).values({ email: `seller-${randomUUID()}@test.local`, passwordHash: "x" }).returning();
  await db.insert(workspaceMembers).values({ userId: u!.id, workspaceId: u!.id, role: "owner" });
  if (o.discord !== false) await saveConnection(db, key, u!.id, "discord", { account: "#orders", credential: hookUrl, destination: { channelName: "orders" } });
  const google = o.google ?? "oauth";
  if (google !== "none") {
    const blob = JSON.stringify({ v: 1, accessToken: ACCESS, accessExpiresAt: null, scope: "openid email https://www.googleapis.com/auth/drive.file" });
    await saveConnection(db, key, u!.id, "google_drive", { account: GOOGLE_USER.email, credential: google === "service" ? JSON.stringify({ client_email: "sa@x.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----" }) : blob, destination: google === "no-folder" ? null : { folderId: FOLDER, title: "Invoices" } });
    if (google === "oauth" || google === "failed" || google === "no-folder") await db.update(connections).set({ authMethod: "oauth", externalId: GOOGLE_USER.id, ...(google === "failed" ? { status: "failed" as const } : {}) }).where(and(eq(connections.userId, u!.id), eq(connections.provider, "google_drive")));
  }
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Orders", slug: `o-${randomUUID().slice(0, 8)}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: { trigger: { type: "manual", config: {} }, steps: [], edges: [] }, published: true }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id }).returning();
  const exec = (step: Step, o2: { mock?: boolean; trigger?: Record<string, unknown>; attempt?: number } = {}) =>
    createExecutor({ db, secretsKey: key, mail: {} as never, urls: { ...fake.urls, timeoutMs: 2000 } }).execute({
      runId: r!.id,
      stepRunId: NO_STEP_RUN,
      userId: u!.id,
      workflowId: wf!.id,
      step,
      attempt: o2.attempt ?? 1,
      idempotencyKey: `${r!.id}:${step.id}`,
      mock: o2.mock,
      ctx: { trigger: o2.trigger ?? { reference: "REQ-7", name: "Ana Cruz", total: "PHP 1,200" }, steps: {} },
    });
  return { userId: u!.id, runId: r!.id, exec };
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting");
}
const deliveriesOf = (runId: string) => db.select().from(deliveries).where(eq(deliveries.runId, runId));

const discordStep = (text = "New order {{trigger.reference}} from {{trigger.name}}"): Step => ({ id: "ping", type: "discord", config: { text } });
const docsStep = (over: Partial<Extract<Step, { type: "google_docs" }>["config"]> = {}): Step => ({
  id: "make_doc",
  type: "google_docs",
  config: { templateId: TEMPLATE, templateName: "Invoice template", name: "Invoice {{trigger.reference}}", values: { name: "{{trigger.name}}", total: "{{trigger.total}}" }, ...over },
});

describe("discord step", () => {
  it("queues the templated message and the worker posts it with no mention parsing", async () => {
    const s = await workspace();
    const before = fake.discord.posts.length;
    const out = await s.exec(discordStep("New order {{trigger.reference}} from {{trigger.name}} @everyone"));
    expect(out.output).toMatchObject({ reference: "REQ-7", state: "queued" });
    const [d] = await until(() => deliveriesOf(s.runId), (x) => x.length === 1 && x[0]!.state === "delivered");
    expect(d).toMatchObject({ provider: "discord", payload: { text: "New order REQ-7 from Ana Cruz @everyone" } });
    expect(fake.discord.posts.slice(before)).toEqual([{ id: "123456789012345678", content: "New order REQ-7 from Ana Cruz @everyone", allowedMentions: { parse: [] } }]);
  });

  it("never copies the webhook URL into a delivery, a step input or a result", async () => {
    const s = await workspace();
    const out = await s.exec(discordStep());
    const [d] = await until(() => deliveriesOf(s.runId), (x) => x.length === 1 && x[0]!.state === "delivered");
    for (const part of [JSON.stringify(out), JSON.stringify(d)]) {
      expect(part).not.toContain(HOOK_TOKEN);
      expect(part).not.toContain("/api/webhooks");
    }
  });

  it("waits out a Discord rate limit and then posts once", async () => {
    const s = await workspace();
    const before = fake.discord.posts.length;
    fake.once("/api/webhooks", { status: 429, headers: { "retry-after": "1" }, body: { message: "You are being rate limited.", retry_after: 1, global: false } });
    await s.exec(discordStep("Rate limited order"));
    const limited = await until(() => deliveriesOf(s.runId), (x) => x[0]?.lastError != null || x[0]?.state === "delivered");
    expect(limited[0]).toMatchObject({ state: expect.stringMatching(/queued|delivered/) });
    const [done] = await until(() => deliveriesOf(s.runId), (x) => x[0]?.state === "delivered");
    expect(done!.attempts).toBeGreaterThanOrEqual(2);
    expect(fake.discord.posts.slice(before).map((p) => p.content)).toEqual(["Rate limited order"]);
  });

  it("fails the delivery and marks the connection when the webhook was deleted, without echoing the URL", async () => {
    const s = await workspace();
    const gone = fake.addDiscordWebhook("223456789012345678", "deleted-webhook-token-AbCdEfGhIjKlMnOpQrStUvWxYz012");
    await saveConnection(db, key, s.userId, "discord", { account: "#old", credential: gone, destination: { channelName: "old" } });
    fake.discord.hooks.delete("223456789012345678");
    await s.exec(discordStep("Hello"));
    const [d] = await until(() => deliveriesOf(s.runId), (x) => x.length === 1 && x[0]!.state === "failed");
    expect(d!.lastError).toMatch(/deleted|new webhook/i);
    expect(JSON.stringify(d)).not.toContain("deleted-webhook-token");
    const [c] = await db.select().from(connections).where(and(eq(connections.userId, s.userId), eq(connections.provider, "discord")));
    expect(c!.status).toBe("failed");
  });

  it("fails the delivery with a plain message when Discord is not connected", async () => {
    const s = await workspace({ discord: false });
    await s.exec(discordStep());
    const [d] = await until(() => deliveriesOf(s.runId), (x) => x.length === 1 && x[0]!.state === "failed");
    expect(d!.lastError).toMatch(/Discord is not connected/);
  });

  it("a test run posts nothing and queues nothing", async () => {
    const s = await workspace();
    const before = fake.discord.posts.length;
    const out = await s.exec(discordStep(), { mock: true });
    expect(out.output).toMatchObject({ mocked: true, text: "New order REQ-7 from Ana Cruz" });
    expect(await deliveriesOf(s.runId)).toEqual([]);
    expect(fake.discord.posts.length).toBe(before);
  });

  it("refuses a message that is empty or over 2000 characters once the values are in, and does not retry", async () => {
    const s = await workspace();
    await expect(s.exec(discordStep("{{trigger.missing}}"))).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/empty/) });
    await expect(s.exec(discordStep("{{trigger.long}}"), { trigger: { long: "x".repeat(2001) } })).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/2000/) });
    expect(await deliveriesOf(s.runId)).toEqual([]);
  });
});

describe("google_docs step", () => {
  it("copies the template into the folder, fills the placeholders and outputs the link", async () => {
    const s = await workspace();
    const out = await s.exec(docsStep());
    const copies = fake.docsCopies().filter((c) => c.name === "Invoice REQ-7");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ parents: [FOLDER], text: "Invoice for Ana Cruz. Total PHP 1,200. Thanks, Ana Cruz." });
    expect(out.output).toEqual({ documentId: copies[0]!.id, url: `https://docs.google.com/document/d/${copies[0]!.id}/edit`, name: "Invoice REQ-7", unmatched: [] });
    expect(out.input).toMatchObject({ name: "Invoice REQ-7", values: { name: "Ana Cruz", total: "PHP 1,200" } });
  });

  it("makes one copy when the step is retried", async () => {
    const s = await workspace();
    const first = await s.exec(docsStep({ name: "Retry copy {{trigger.reference}}" }));
    const second = await s.exec(docsStep({ name: "Retry copy {{trigger.reference}}" }), { attempt: 2 });
    expect(fake.docsCopies().filter((c) => c.name === "Retry copy REQ-7")).toHaveLength(1);
    expect((second.output as { documentId: string }).documentId).toBe((first.output as { documentId: string }).documentId);
  });

  it("puts a visitor's {{placeholder}} text into the document as typed", async () => {
    const s = await workspace();
    await s.exec(docsStep({ name: "Literal copy" }), { trigger: { name: "{{total}}", total: "PHP 5" } });
    expect(fake.docsCopies().find((c) => c.name === "Literal copy")!.text).toBe("Invoice for {{total}}. Total PHP 5. Thanks, {{total}}.");
  });

  it("lists placeholders the template does not contain", async () => {
    const s = await workspace();
    const out = await s.exec(docsStep({ name: "Unmatched copy", values: { name: "Ana", due_date: "Friday" } }));
    expect((out.output as { unmatched: string[] }).unmatched).toEqual(["due_date"]);
  });

  it("a test run returns a sample link and touches nothing", async () => {
    const s = await workspace();
    const before = fake.docsCopies().length;
    const out = await s.exec(docsStep({ name: "Mock copy" }), { mock: true });
    expect(out.output).toMatchObject({ mocked: true, name: "Mock copy", unmatched: [] });
    expect((out.output as { url: string }).url).toMatch(/^https:\/\/docs\.google\.com\/document\/d\/[\w-]+\/edit$/);
    expect(fake.docsCopies().length).toBe(before);
  });

  it("explains what to fix, without retrying, when Drive is not ready", async () => {
    const not = async (g: "none" | "service" | "failed" | "no-folder") => (await workspace({ google: g })).exec(docsStep({ name: `x ${g}` })).then(() => "ok", (e: Error & { retryable: boolean }) => ({ retryable: e.retryable, message: e.message }));
    expect(await not("none")).toMatchObject({ retryable: false, message: expect.stringMatching(/Connect Google Drive/) });
    expect(await not("service")).toMatchObject({ retryable: false, message: expect.stringMatching(/Google sign-in/) });
    expect(await not("failed")).toMatchObject({ retryable: false, message: expect.stringMatching(/connected again/) });
    expect(await not("no-folder")).toMatchObject({ retryable: false, message: expect.stringMatching(/folder/i) });
  });

  it("asks for the template to be picked again when this Google account never picked it", async () => {
    const s = await workspace();
    await expect(s.exec(docsStep({ templateId: "1SomeoneElsesTemplateId" }))).rejects.toMatchObject({ retryable: false, outcome: "rejected", message: expect.stringMatching(/pick the template again/i) });
  });

  it("retries a rate limit after the wait Google gave, and an outage", async () => {
    const s = await workspace();
    fake.once("/copy", { status: 429, headers: { "retry-after": "2" }, body: {} });
    await expect(s.exec(docsStep({ name: "Throttled copy" }))).rejects.toMatchObject({ retryable: true, outcome: "throttled", retryAfterMs: 2000 });
    fake.once("/copy", { status: 503, body: {} });
    await expect(s.exec(docsStep({ name: "Outage copy" }))).rejects.toMatchObject({ retryable: true, outcome: "not_sent" });
    expect(fake.docsCopies().filter((c) => c.name === "Throttled copy" || c.name === "Outage copy")).toEqual([]);
  });

  it("does not retry when Google no longer accepts the grant", async () => {
    const s = await workspace();
    fake.once("/drive/v3/files", { status: 401, body: { error: { code: 401, message: "Invalid Credentials" } } });
    await expect(s.exec(docsStep({ name: "Auth copy" }))).rejects.toMatchObject({ retryable: false });
  });

  it("refuses an empty name before any request", async () => {
    const s = await workspace();
    const before = fake.docsCopies().length;
    await expect(s.exec(docsStep({ name: "{{trigger.missing}}" }))).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/name/i) });
    expect(fake.docsCopies().length).toBe(before);
  });
});
