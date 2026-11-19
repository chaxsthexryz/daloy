import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../../test/fake-providers";
import { connectionCredential, readConnections, saveConnection, setDestination } from "../connections";
import { queueDelivery, runDueDeliveries } from "../deliveries";
import type { Db } from "../index";
import { airtableAdd, notionAddPage, trelloAddCard, type ProviderUrls } from "../providers";
import { connections, deliveries, runs, users, workflows, workflowVersions } from "../schema";
import { airtable, airtableBases, airtableTables, consumeFlow, disconnectOAuth, finishFlow, keepOAuthAlive, notion, notionDatabases, readTokenBlob, startFlow, trello, trelloAuthOf, trelloBoards, trelloLists, withRecordAuth, type OAuthProvider } from "./index";

const key = randomBytes(32);
const publicUrl = "http://localhost:3000";
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
const defs = [airtable, notion, trello];
const target = {
  airtable: { baseId: "appFAKEBASE000001", tableId: "tblFAKETABLE00001" },
  notion: { databaseId: "0123456789abcdef0123456789abcdef", titleProperty: "Name" },
  trello: { boardId: "5f0000000000000000000010", listId: "5f0000000000000000000001" },
};

async function owner() {
  return (await db.insert(users).values({ email: `records-${randomBytes(8).toString("hex")}@test.local`, passwordHash: "x" }).returning())[0]!.id;
}
async function consent(ws: string, def: OAuthProvider) {
  const url = await startFlow(db, key, urls, publicUrl, def, { workspaceId: ws, memberId: ws });
  const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
  const flow = await consumeFlow(db, key, back.searchParams.get("state")!, { workspaceId: ws, memberId: ws });
  return finishFlow(db, key, urls, publicUrl, def, ws, back.searchParams.get("code")!, flow!.verifier);
}
async function held(ws: string, def: OAuthProvider) {
  return (await connectionCredential(db, key, ws, def.provider))!;
}
async function newRun(ws: string) {
  const [wf] = await db.insert(workflows).values({ userId: ws, name: "Record", slug: randomBytes(8).toString("hex") }).returning();
  const [version] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  return (await db.insert(runs).values({ workflowVersionId: version!.id, triggerPayload: {} }).returning())[0]!.id;
}
beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  urls = { ...fake.urls, ...fake.recordClients(), timeoutMs: 1000 };
}, 120_000);
afterAll(async () => { await fake?.close(); await pool?.end(); });
beforeEach(() => {
  for (const def of defs) {
    const app = fake.oauth[def.slug]!;
    Object.assign(app, { consent: "grant", refresh: true, expiresIn: 3600, revokeStatus: 200 });
    app.user = { id: `${def.slug}-user-1`, email: `ana@${def.slug}.example` };
    app.seen.length = 0;
  }
  fake.airtable.revoked = false;
  fake.notion.revoked = false;
  fake.trello.revoked = false;
});

describe("record apps with their provider definitions", () => {
  for (const def of defs) {
    it(`${def.name} exchanges, refreshes rotating credentials and keeps tokens out of the connection response`, async () => {
      const ws = await owner();
      expect(await consent(ws, def)).toBe("connected");
      const conn = await held(ws, def);
      expect(conn.authMethod).toBe("oauth");
      const before = readTokenBlob(conn.credential);
      expect(await withRecordAuth(db, key, urls, ws, def, conn, async (t) => t, { force: true })).not.toBe(before.accessToken);
      expect(readTokenBlob(conn.credential).refreshToken).not.toBe(before.refreshToken);
      expect(JSON.stringify(await readConnections(db, ws))).not.toMatch(/access-|refresh-|client-secret/);
      const seen = fake.oauth[def.slug]!.seen;
      expect(seen).toHaveLength(2);
      for (const call of seen) {
        expect(call.basic).toBe(def.tokenAuth === "basic");
        expect(call.json).toBe(def.tokenFormat === "json");
        if (def.tokenAuth === "basic") expect(call.fields).not.toContain("client_secret");
        if (def === notion) expect(call.notionVersion).toBe(true);
      }
    });

    it(`${def.name} keeps a target for the same account and clears it for another account`, async () => {
      const ws = await owner();
      await consent(ws, def);
      await setDestination(db, ws, def.provider, target[def.slug as keyof typeof target]);
      await consent(ws, def);
      expect((await held(ws, def)).destination).toEqual(target[def.slug as keyof typeof target]);
      fake.oauth[def.slug]!.user.id = "another-account";
      await consent(ws, def);
      expect((await held(ws, def)).destination).toBeNull();
    });

    it(`${def.name} continues a pasted delivery at the same target after OAuth, and holds a moved target`, async () => {
      const ws = await owner();
      const destination = target[def.slug as keyof typeof target];
      await saveConnection(db, key, ws, def.provider, { account: "Pasted", credential: "unused", destination });
      const runId = await newRun(ws);
      const payload = { fields: { Notes: "Fixture" }, title: "Fixture", name: "Fixture" };
      const first = await queueDelivery(db, { userId: ws, runId, stepId: "record", provider: def.provider, reference: "FIXTURE", payload });
      await consent(ws, def);
      await setDestination(db, ws, def.provider, destination);
      await runDueDeliveries(db, key, urls);
      expect((await db.select().from(deliveries).where(eq(deliveries.id, first!.id)))[0]!.state).toBe("delivered");
      const second = await queueDelivery(db, { userId: ws, runId, stepId: "second", provider: def.provider, reference: "FIXTURE-2", payload });
      await setDestination(db, ws, def.provider, def === airtable ? { ...destination, tableId: "tblFAKETABLE00002" } : def === notion ? { ...destination, databaseId: fake.notion.more[0]!.id } : { ...destination, listId: "5f0000000000000000000002" });
      await runDueDeliveries(db, key, urls);
      expect((await db.select().from(deliveries).where(eq(deliveries.id, second!.id)))[0]).toMatchObject({ state: "needs_review", errorKind: "destination_changed" });
    });
  }

  it("lists writable Airtable bases, database titles and open Trello lists without writing records", async () => {
    const ws = await owner();
    for (const def of defs) await consent(ws, def);
    const token = async (def: OAuthProvider) => readTokenBlob((await held(ws, def)).credential).accessToken;
    expect(await airtableBases(urls, await token(airtable))).toEqual([{ id: fake.airtable.base, name: "Office" }, { id: "appFAKEBASE000003", name: "Second base" }]);
    expect(await airtableTables(urls, await token(airtable), fake.airtable.base)).toHaveLength(2);
    expect(await notionDatabases(urls, await token(notion))).toContainEqual({ id: fake.notion.database, name: fake.notion.title });
    expect(await trelloBoards(urls, { bearer: await token(trello) })).toHaveLength(2);
    expect(await trelloLists(urls, { bearer: await token(trello) }, target.trello.boardId)).toHaveLength(2);
  });

  it("tests a nonexpiring Notion grant without a refresh token, and the idle sweep leaves it usable", async () => {
    const ws = await owner();
    Object.assign(fake.oauth.notion!, { refresh: false, expiresIn: undefined });
    await consent(ws, notion);
    const conn = await held(ws, notion);
    const calls = fake.oauth.notion!.tokenCalls;
    await withRecordAuth(db, key, urls, ws, notion, conn, (t) => notionAddPage(urls, t, target.notion, "Test", {}), { force: true });
    await db.update(connections).set({ refreshedAt: sql`now() - interval '40 days'` }).where(and(eq(connections.userId, ws), eq(connections.provider, "notion")));
    await keepOAuthAlive(db, key, urls, [notion]);
    expect(fake.oauth.notion!.tokenCalls).toBe(calls);
    expect((await held(ws, notion)).status).toBe("active");
  });

  it("revokes Notion with its access token using Basic auth and JSON", async () => {
    const ws = await owner();
    await consent(ws, notion);
    const blob = readTokenBlob((await held(ws, notion)).credential);
    expect(await disconnectOAuth(db, key, urls, ws, notion)).toEqual({ removed: true, revoked: true });
    expect(fake.oauth.notion!.revoked).toContain(blob.accessToken);
    expect(fake.oauth.notion!.revoked).not.toContain(blob.refreshToken);
  });

  it("the idle sweep rotates Airtable and Trello credentials and does not repeat a fresh sweep", async () => {
    const ws = await owner();
    for (const def of [airtable, trello]) await consent(ws, def);
    await db.update(connections).set({ refreshedAt: sql`now() - interval '60 days'` }).where(eq(connections.userId, ws));
    expect(await keepOAuthAlive(db, key, urls, [airtable, trello])).toBe(2);
    expect(await keepOAuthAlive(db, key, urls, [airtable, trello])).toBe(0);
  });

  it("uses the pasted credentials without interpreting them as OAuth blobs", async () => {
    const ws = await owner();
    fake.airtable.token = "pasted-airtable";
    fake.notion.token = "pasted-notion";
    fake.trello.key = "pasted-key";
    fake.trello.token = "pasted-trello";
    for (const def of defs) {
      const credential = def === airtable ? fake.airtable.token : def === notion ? fake.notion.token : JSON.stringify({ key: fake.trello.key, token: fake.trello.token });
      await saveConnection(db, key, ws, def.provider, { account: "Pasted", credential, destination: target[def.slug as keyof typeof target] });
      const conn = await held(ws, def);
      await withRecordAuth(db, key, urls, ws, def, conn, (t) => def === airtable ? airtableAdd(urls, t, target.airtable, { Notes: "Test" }) : def === notion ? notionAddPage(urls, t, target.notion, "Test", {}) : trelloAddCard(urls, trelloAuthOf(conn.authMethod, t), target.trello.listId, "Test", ""));
    }
  });
});
