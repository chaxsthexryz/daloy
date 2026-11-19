import { randomBytes } from "node:crypto";
import { connectionCredential, joinWorkspace, saveConnection, sessions, users, type Db } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";
import { sha256 } from "./http";

let db: Db;
let pool: Pool;
let boss: PgBoss;
let app: INestApplication;
let fake: FakeProviders;
let server: Parameters<typeof request>[0];
const key = randomBytes(32);
let seq = 0;
type Agent = ReturnType<typeof request.agent>;
const paths = { airtable: "bases", notion: "databases", trello: "boards" } as const;
const targets = {
  airtable: { baseId: "appFAKEBASE000001", tableId: "tblFAKETABLE00001" },
  notion: { databaseId: "0123456789abcdef0123456789abcdef" },
  trello: { boardId: "5f0000000000000000000010", listId: "5f0000000000000000000001" },
};
type Slug = keyof typeof targets;

beforeAll(async () => {
  let url: string;
  ({ db, pool, url } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  app = await createApp({ db, boss, secretsKey: key, secureCookies: false, publicUrl: "http://localhost:3000", providers: { ...fake.urls, ...fake.recordClients(), timeoutMs: 2000 } });
  await app.init();
  server = app.getHttpServer();
}, 120_000);
afterAll(async () => { await app?.close(); await boss?.stop({ graceful: false }); await fake?.close(); await pool?.end(); });
beforeEach(() => {
  for (const slug of Object.keys(targets)) Object.assign(fake.oauth[slug]!, { consent: "grant", refresh: true, expiresIn: 3600 });
  fake.airtable.revoked = false;
  fake.notion.revoked = false;
  fake.trello.revoked = false;
});
async function owner() {
  const agent = request.agent(server);
  const { body } = await agent.post("/auth/register").send({ email: `record-api-${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: body.id as string };
}
async function consent(agent: Agent, slug: Slug) {
  const { body } = await agent.post(`/settings/connections/${slug}/oauth/start`).expect(200);
  const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
  return agent.get(back.pathname + back.search).expect(302);
}

describe("record app pickers", () => {
  for (const slug of Object.keys(targets) as Slug[]) {
    it(`${slug} connects, lists, saves a verified target, and tests using OAuth`, async () => {
      const { agent, id } = await owner();
      expect((await consent(agent, slug)).headers.location).toBe(`/#/apps/${slug}-connected`);
      const listed = await agent.get(`/settings/connections/${slug}/${paths[slug]}`).expect(200);
      expect(listed.body.length).toBeGreaterThan(0);
      await agent.put(`/settings/connections/${slug}/target`).send(targets[slug]).expect(204);
      expect((await connectionCredential(db, key, id, slug))!.destination).toMatchObject(targets[slug]);
      expect((await agent.post(`/settings/connections/${slug}/test`).expect(200)).body.ok).toBe(true);
      const json = JSON.stringify((await agent.get("/settings/connections").expect(200)).body);
      expect(json).not.toMatch(/access-|refresh-|client-secret/);
    });

    it(`${slug} saves nothing after refusal or missing permissions`, async () => {
      const { agent, id } = await owner();
      fake.oauth[slug]!.consent = "declined";
      expect((await consent(agent, slug)).headers.location).toBe(`/#/apps/${slug}-declined`);
      expect(await connectionCredential(db, key, id, slug)).toBeNull();
      if (slug !== "notion") {
        Object.assign(fake.oauth[slug]!, { consent: "narrow", grantScopes: [] });
        expect((await consent(agent, slug)).headers.location).toBe(`/#/apps/${slug}-missing_scope`);
        expect(await connectionCredential(db, key, id, slug)).toBeNull();
      }
    });

    it(`${slug} requires an owner, a connection and an OAuth grant for its lists`, async () => {
      await request(server).get(`/settings/connections/${slug}/${paths[slug]}`).expect(401);
      const { agent, id } = await owner();
      await agent.get(`/settings/connections/${slug}/${paths[slug]}`).expect(404);
      await saveConnection(db, key, id, slug, { account: "Pasted", credential: "unused" });
      await agent.get(`/settings/connections/${slug}/${paths[slug]}`).expect(400);
      for (const role of ["operator", "approver", "requester"] as const) {
        const [u] = await db.insert(users).values({ email: `${role}-record-${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
        await joinWorkspace(db, u!.id, id, role);
        const token = randomBytes(32).toString("base64url");
        await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
        const member = request.agent(server).set("Cookie", `daloy_session=${token}`);
        await member.get(`/settings/connections/${slug}/${paths[slug]}`).expect(403);
        await member.put(`/settings/connections/${slug}/target`).send(targets[slug]).expect(403);
      }
    });
  }

  it("keeps targets inside their parent list and rejects names in place of Airtable table ids", async () => {
    const { agent, id } = await owner();
    await consent(agent, "airtable");
    await agent.put("/settings/connections/airtable/target").send({ baseId: targets.airtable.baseId, tableId: "tblFAKETABLE00004" }).expect(400);
    await agent.put("/settings/connections/airtable/target").send({ baseId: targets.airtable.baseId, tableId: "Requests" }).expect(400);
    await agent.get("/settings/connections/airtable/bases/appFAKEBASE000002/tables").expect(400);
    await consent(agent, "trello");
    await agent.put("/settings/connections/trello/target").send({ boardId: targets.trello.boardId, listId: "5f0000000000000000000003" }).expect(400);
    await agent.put("/settings/connections/trello/target").send({ boardId: targets.trello.boardId, listId: "5f0000000000000000000004" }).expect(400);
    await consent(agent, "notion");
    await agent.put("/settings/connections/notion/target").send({ databaseId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).expect(400);
    for (const slug of Object.keys(targets) as Slug[]) expect((await connectionCredential(db, key, id, slug))!.destination).toBeNull();
  });

  it("normalizes a Notion database id and saves its title property from the provider", async () => {
    const { agent, id } = await owner();
    await consent(agent, "notion");
    await agent.put("/settings/connections/notion/target").send({ databaseId: "01234567-89AB-CDEF-0123-456789ABCDEF" }).expect(204);
    expect((await connectionCredential(db, key, id, "notion"))!.destination).toEqual({ databaseId: targets.notion.databaseId, databaseTitle: fake.notion.title, titleProperty: fake.notion.titleProperty });
  });

  it("refuses a target save when the credential changes while the provider list is loading", async () => {
    const { agent, id } = await owner();
    await consent(agent, "airtable");
    let release!: () => void;
    const heldUntil = new Promise<void>((resolve) => { release = resolve; });
    const calls = fake.calls.length;
    fake.once("/v0/meta/bases", { heldUntil, status: 200, body: { bases: [{ id: targets.airtable.baseId, name: "Office", permissionLevel: "create" }] } });
    const pending = agent.put("/settings/connections/airtable/target").send(targets.airtable).then((r) => r);
    try {
      await expect.poll(() => fake.calls.slice(calls).includes("GET /v0/meta/bases")).toBe(true);
      await saveConnection(db, key, id, "airtable", { account: "Replacement", credential: "replacement", destination: { baseId: "appFAKEBASE000003", tableId: "tblFAKETABLE00004" } });
    } finally { release(); }
    expect((await pending).status).toBe(409);
    expect((await connectionCredential(db, key, id, "airtable"))!.account).toBe("Replacement");
    expect((await connectionCredential(db, key, id, "airtable"))!.destination!.baseId).toBe("appFAKEBASE000003");
  });
});
