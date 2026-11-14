import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { requests, runs, stepRuns, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { defaultAnswers, defaultPurchaseAnswers, officeRequestDefinition, PURCHASE_REQUEST, purchaseRequestDefinition } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { runStatus, toolsFromRows } from "./mcp";

const FIELDS = [
  { name: "email", label: "Email", type: "email", required: true },
  { name: "message", label: "Message", type: "textarea", required: false },
] as const;

describe("tool mapping", () => {
  it("names each tool after the workflow slug and validates input with the form fields", () => {
    const [tool] = toolsFromRows([{ slug: "inquiry", name: "Inquiry triage", versionId: "v1", fields: [...FIELDS], workflowId: "w1", tracked: false }]);
    expect(tool).toMatchObject({ name: "inquiry", title: "Inquiry triage", versionId: "v1" });
    expect(tool!.inputSchema.safeParse({ email: "ana@example.com" }).success).toBe(true);
    expect(tool!.inputSchema.safeParse({ message: "no email" }).success).toBe(false);
    expect(tool!.inputSchema.safeParse({ email: "not an email" }).success).toBe(false);
  });

  it("reports waiting_approval only while the last step run is a waiting approval step", () => {
    const def = { steps: [{ id: "ask", type: "approval" }, { id: "pause", type: "delay" }] };
    expect(runStatus("waiting", { stepId: "ask", state: "waiting" }, def)).toBe("waiting_approval");
    expect(runStatus("waiting", { stepId: "pause", state: "waiting" }, def)).toBe("waiting");
    expect(runStatus("running", { stepId: "ask", state: "succeeded" }, def)).toBe("running");
    expect(runStatus("pending", undefined, def)).toBe("pending");
    expect(runStatus("failed", { stepId: "gone", state: "failed" }, def)).toBe("failed");
  });
});

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let base: string;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

let seq = 0;
/** A signed-in console user with an API token. */
async function owner() {
  const agent = request.agent(app.getHttpServer());
  const email = `mcp${++seq}@test.local`;
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const token = (await agent.post("/tokens").send({ name: "claude" }).expect(201)).body as { id: string; token: string };
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { agent, token: token.token, tokenId: token.id, userId: user!.id };
}

const twoDelays = (trigger: object) => ({
  trigger,
  steps: [
    { id: "a", type: "delay", config: { seconds: 1 } },
    { id: "b", type: "delay", config: { seconds: 1 } },
  ],
  edges: [{ from: "a", to: "b" }],
});
const formTrigger = { type: "form", config: { fields: FIELDS } };

async function workflow(agent: request.Agent, trigger: object, publish = true) {
  const slug = `wf-${++seq}`;
  const wf = await agent.post("/workflows").send({ name: `Workflow ${seq}`, slug }).expect(201);
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: twoDelays(trigger), publish }).expect(201);
  return { id: wf.body.id as string, slug };
}

async function connect(token: string) {
  const client = new Client({ name: "daloy-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

/** A tool error may come back as an isError result or as a protocol error, depending on where it was caught. */
async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content?: unknown; structuredContent?: unknown }> {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: String(err) }] };
  }
}
const text = (res: { content?: unknown }) => JSON.stringify(res.content);

const rawPost = (token?: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
    }),
  });

describe("MCP endpoint", () => {
  it("rejects a missing, unknown or revoked token with 401", async () => {
    const { agent, token, tokenId } = await owner();
    for (const bad of [undefined, "dly_unknown"]) {
      const res = await rawPost(bad);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
    await agent.delete(`/tokens/${tokenId}`).expect(204);
    expect((await rawPost(token)).status).toBe(401);
  });

  it("serves 2025-era clients through the stateless fallback", async () => {
    const { token } = await owner();
    const res = await rawPost(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"serverInfo"');
  });

  it("lists only the owner's published form workflows and records last use", async () => {
    const a = await owner();
    const b = await owner();
    const mine = await workflow(a.agent, formTrigger);
    await workflow(a.agent, formTrigger, false);
    await workflow(a.agent, { type: "manual" });
    await workflow(b.agent, formTrigger);

    const client = await connect(a.token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_run_status", mine.slug]);
    const tool = tools.find((t) => t.name === mine.slug)!;
    expect(tool.inputSchema).toMatchObject({ type: "object", required: ["email"] });
    await client.close();

    const [listed] = (await a.agent.get("/tokens").expect(200)).body as { lastUsedAt: string | null }[];
    expect(listed!.lastUsedAt).not.toBeNull();
  });

  it("starts a run with the validated arguments and rejects bad input", async () => {
    const { agent, token } = await owner();
    const wf = await workflow(agent, formTrigger);
    const client = await connect(token);

    const bad = await callTool(client, wf.slug, { email: "nope" });
    expect(bad.isError).toBe(true);

    const res = await callTool(client, wf.slug, { email: "ana@example.com", message: "Hi" });
    expect(res.isError).toBeFalsy();
    const { runId, status } = res.structuredContent as { runId: string; status: string };
    expect(status).toBe("pending");
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run).toMatchObject({ state: "pending", test: false, triggerPayload: { email: "ana@example.com", message: "Hi" } });
    const rows = await db.select().from(runs);
    expect(rows.filter((r) => (r.triggerPayload as { email?: string }).email === "nope")).toEqual([]);

    const status1 = await callTool(client, "get_run_status", { runId });
    expect(status1.structuredContent).toMatchObject({ runId, status: "pending" });
    await client.close();
  });

  it("records an office request with a reference when a tool starts an office request workflow", async () => {
    const { agent, token } = await owner();
    const answers = defaultAnswers("office@test.local");
    const wf = await agent.post("/workflows").send({ name: "Office requests", slug: `office-${++seq}` }).expect(201);
    await agent.patch(`/workflows/${wf.body.id}/setup`).send({ step: "review", answers }).expect(200);
    await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: officeRequestDefinition(answers), publish: true }).expect(201);
    const client = await connect(token);

    const res = await callTool(client, wf.body.slug, { name: "Rosa", email: "rosa@example.com", summary: "Broken chair" });
    const { runId, reference } = res.structuredContent as { runId: string; reference: string };
    expect(reference).toMatch(/^REQ-[0-9A-Z]{6}$/);
    const [row] = await db.select().from(requests).where(eq(requests.runId, runId));
    expect(row).toMatchObject({ reference, subject: "Broken chair" });
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run!.triggerPayload).toMatchObject({ reference });
    await client.close();
  });

  it("records a purchase request with a reference too, like the hosted form", async () => {
    const { agent, token, userId } = await owner();
    // The approver must be a member who may approve: the owner is.
    const [me] = await db.select().from(users).where(eq(users.id, userId));
    const answers = defaultPurchaseAnswers(me!.email);
    const wf = await agent.post("/workflows").send({ name: "Purchases", slug: `purchase-${++seq}` }).expect(201);
    await agent.patch(`/workflows/${wf.body.id}/setup`).send({ template: PURCHASE_REQUEST, step: "review", answers }).expect(200);
    await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition: purchaseRequestDefinition(answers), publish: true }).expect(201);
    const client = await connect(token);

    const res = await callTool(client, wf.body.slug, { name: "Rosa", email: "rosa@example.com", summary: "Printer", cost: "7800", reason: "Ours broke" });
    const { runId, reference } = res.structuredContent as { runId: string; reference: string };
    expect(reference).toMatch(/^REQ-[0-9A-Z]{6}$/);
    expect(await db.select().from(requests).where(eq(requests.runId, runId))).toHaveLength(1);
    await client.close();
  });

  it("hides other users' runs and reports a waiting approval", async () => {
    const a = await owner();
    const b = await owner();
    const theirs = await workflow(b.agent, formTrigger);
    const bClient = await connect(b.token);
    const started = await callTool(bClient, theirs.slug, { email: "bo@example.com" });
    const theirRun = (started.structuredContent as { runId: string }).runId;
    await bClient.close();

    // A run parked on an approval step, as the worker leaves it.
    const [wf] = await db.insert(workflows).values({ userId: a.userId, name: "Refunds", slug: `refunds-${++seq}` }).returning();
    const definition = { trigger: { type: "manual", config: {} }, steps: [{ id: "ask", type: "approval", config: {} }], edges: [] };
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: true }).returning();
    const [run] = await db.insert(runs).values({ workflowVersionId: v!.id, state: "waiting" }).returning();
    await db.insert(stepRuns).values({ runId: run!.id, stepId: "ask", attempt: 1, state: "waiting" });

    const client = await connect(a.token);
    const waiting = await callTool(client, "get_run_status", { runId: run!.id });
    expect(waiting.structuredContent).toMatchObject({ runId: run!.id, status: "waiting_approval" });
    for (const runId of [theirRun, randomUUID()]) {
      const res = await callTool(client, "get_run_status", { runId });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain("run not found");
    }
    await client.close();
  });

  // Last in the file: it uses up the per-IP budget of the route.
  it("rate limits the route", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await rawPost()).status);
    expect(statuses.at(-1)).toBe(429);
  });
});
