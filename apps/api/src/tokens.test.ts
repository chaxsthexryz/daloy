import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { apiTokens, runs, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

type Scope = "read" | "run" | "manage";
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let base: string;
let seq = 0;

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

const FIELDS = [{ name: "email", label: "Email", type: "email", required: true }];

/** A signed-in account with one published form workflow. */
async function account() {
  const agent = request.agent(app.getHttpServer());
  await agent.post("/auth/register").send({ email: `tok${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  const slug = `wf-${seq}`;
  const wf = await agent.post("/workflows").send({ name: `Workflow ${seq}`, slug }).expect(201);
  const definition = { trigger: { type: "form", config: { fields: FIELDS } }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
  return { agent, slug };
}
const mint = async (agent: request.Agent, scopes: Scope[], extra: Record<string, unknown> = {}) =>
  (await agent.post("/tokens").send({ name: "claude", scopes, ...extra }).expect(201)).body as { id: string; token: string; scopes: Scope[]; expiresAt: string | null };

async function connect(token: string) {
  const client = new Client({ name: "tokens-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
/** A tool error may come back as an isError result or as a protocol error, depending on where it was caught. */
async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; structuredContent?: unknown }> {
  try {
    return await client.callTool({ name, arguments: args });
  } catch {
    return { isError: true };
  }
}
const toolNames = async (token: string) => {
  const client = await connect(token);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close();
  return names;
};
const rawPost = (token: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }),
  });

describe("creating a token", () => {
  it("needs scopes, and takes only read, run and manage once each", async () => {
    const { agent } = await account();
    const post = (body: object) => agent.post("/tokens").send({ name: "claude", ...body });
    await post({}).expect(400);
    await post({ scopes: [] }).expect(400);
    await post({ scopes: ["admin"] }).expect(400);
    await post({ scopes: ["read", "read"] }).expect(400);
    await post({ scopes: "read" }).expect(400);
    await post({ scopes: ["read"] }).expect(201);
  });

  it("takes an expiry of 1 to 365 whole days", async () => {
    const { agent } = await account();
    for (const expiresInDays of [0, 366, 1.5, -1, "7"]) await agent.post("/tokens").send({ name: "claude", scopes: ["read"], expiresInDays }).expect(400);
    for (const expiresInDays of [1, 365]) await agent.post("/tokens").send({ name: "claude", scopes: ["read"], expiresInDays }).expect(201);
  });

  it("lists scopes and expiry, with no expiry as null", async () => {
    const { agent } = await account();
    await mint(agent, ["read", "run"], { expiresInDays: 30 });
    await mint(agent, ["manage"]);
    const [forever, thirty] = (await agent.get("/tokens").expect(200)).body as { scopes: Scope[]; expiresAt: string | null }[];
    expect(forever).toMatchObject({ scopes: ["manage"], expiresAt: null });
    expect(thirty!.scopes).toEqual(["read", "run"]);
    const days = (new Date(thirty!.expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });
});

describe("scopes on the MCP endpoint", () => {
  it("lets a read token see only the read tools, and refuses the others", async () => {
    const { agent, slug } = await account();
    const { token } = await mint(agent, ["read"]);
    expect(await toolNames(token)).toEqual(["get_run_status", "list_bookings"]);
    const client = await connect(token);
    expect((await callTool(client, slug, { email: "ana@example.com" })).isError).toBe(true);
    expect((await callTool(client, "resolve_run", { runId: "00000000-0000-4000-8000-000000000000", action: "stop" })).isError).toBe(true);
    expect((await callTool(client, "list_bookings", {})).isError).toBeFalsy();
    await client.close();
  });

  it("lets a run token start a run but not read its status", async () => {
    const { agent, slug } = await account();
    const { token } = await mint(agent, ["run"]);
    expect(await toolNames(token)).toEqual([slug]);
    const client = await connect(token);
    const started = await callTool(client, slug, { email: "ana@example.com" });
    expect(started.isError).toBeFalsy();
    const { runId } = started.structuredContent as { runId: string };
    expect(await db.select().from(runs).where(eq(runs.id, runId))).toHaveLength(1);
    expect((await callTool(client, "get_run_status", { runId })).isError).toBe(true);
    await client.close();
  });

  it("lets a manage token change runs and bookings only", async () => {
    const { agent } = await account();
    const { token } = await mint(agent, ["manage"]);
    expect(await toolNames(token)).toEqual(["cancel_booking", "reschedule_booking", "resolve_run"]);
  });

  it("combines scopes", async () => {
    const { agent, slug } = await account();
    const { token } = await mint(agent, ["read", "run", "manage"]);
    expect(await toolNames(token)).toEqual(["cancel_booking", "get_run_status", "list_bookings", slug, "reschedule_booking", "resolve_run"].sort());
  });
});

describe("expiry and revocation", () => {
  it("answers an expired token with 401 and does not record a use", async () => {
    const { agent } = await account();
    const { id, token } = await mint(agent, ["read"], { expiresInDays: 1 });
    expect((await rawPost(token)).status).toBe(200);
    await db.update(apiTokens).set({ expiresAt: sql`now() - interval '1 second'`, lastUsedAt: null }).where(eq(apiTokens.id, id));
    const res = await rawPost(token);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, id));
    expect(row!.lastUsedAt).toBeNull();
  });

  it("keeps a token with a future expiry working and records its use", async () => {
    const { agent } = await account();
    const { id, token } = await mint(agent, ["read"], { expiresInDays: 7 });
    expect((await rawPost(token)).status).toBe(200);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, id));
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it("still answers a revoked token with 401", async () => {
    const { agent } = await account();
    const { id, token } = await mint(agent, ["read", "run", "manage"]);
    expect((await rawPost(token)).status).toBe(200);
    await agent.delete(`/tokens/${id}`).expect(204);
    expect((await rawPost(token)).status).toBe(401);
  });
});
