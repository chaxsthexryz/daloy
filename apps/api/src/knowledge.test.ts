import { randomBytes } from "node:crypto";
import { knowledgeVersions, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, publicUrl: "https://daloy.example.com" });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

let seq = 0;
async function owner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `kn${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}

const room = { kind: "room", title: "Garden room", body: "Sleeps four, fan only.", fields: { price: 3500, unit: "night", capacity: 4, deposit: { mode: "percent", value: 30 } } };

describe("knowledge sheet", () => {
  it("starts empty and refuses to publish nothing", async () => {
    const o = await owner();
    expect((await o.agent.get("/knowledge").expect(200)).body).toEqual({ entries: [], published: null, changed: false, versions: [] });
    await o.agent.post("/knowledge/publish").expect(400);
  });

  it("publishes an immutable numbered version of the drafts", async () => {
    const o = await owner();
    const created = (await o.agent.post("/knowledge/entries").send(room).expect(201)).body;
    await o.agent.post("/knowledge/entries").send({ kind: "policy", title: "Check-in", body: "From 2 pm." }).expect(201);
    expect((await o.agent.get("/knowledge").expect(200)).body).toMatchObject({ published: null, changed: true });

    const published = (await o.agent.post("/knowledge/publish").expect(201)).body;
    expect(published).toMatchObject({ version: 1, entryCount: 2 });
    const state = (await o.agent.get("/knowledge").expect(200)).body;
    expect(state).toMatchObject({ published: { version: 1, entryCount: 2 }, changed: false });
    const v1 = (await o.agent.get("/knowledge/versions/1").expect(200)).body;
    expect(v1.entries.map((e: { kind: string }) => e.kind)).toEqual(["room", "policy"]);
    expect(v1.entries[0]).toMatchObject({ id: created.id, title: "Garden room", fields: { price: 3500 } });

    // The row itself refuses an update, even from code that bypasses the API.
    await expect(db.update(knowledgeVersions).set({ entries: [] }).where(eq(knowledgeVersions.userId, o.id))).rejects.toThrow();
    expect((await o.agent.get("/knowledge/versions/1").expect(200)).body).toEqual(v1);
  });

  it("keeps the version in use when a draft is edited or deleted, and publishes the change as the next version", async () => {
    const o = await owner();
    const created = (await o.agent.post("/knowledge/entries").send(room).expect(201)).body;
    await o.agent.post("/knowledge/publish").expect(201);
    const v1 = (await o.agent.get("/knowledge/versions/1").expect(200)).body;

    await o.agent.patch(`/knowledge/entries/${created.id}`).send({ ...room, fields: { ...room.fields, price: 9900 } }).expect(200);
    let state = (await o.agent.get("/knowledge").expect(200)).body;
    expect(state.entries[0].fields.price).toBe(9900);
    expect(state).toMatchObject({ published: { version: 1 }, changed: true });
    expect((await o.agent.get("/knowledge/versions/1").expect(200)).body).toEqual(v1);

    expect((await o.agent.post("/knowledge/publish").expect(201)).body.version).toBe(2);
    expect((await o.agent.get("/knowledge/versions/1").expect(200)).body).toEqual(v1);
    expect((await o.agent.get("/knowledge/versions/2").expect(200)).body.entries[0].fields.price).toBe(9900);
    await o.agent.post("/knowledge/publish").expect(400); // nothing changed since version 2

    await o.agent.delete(`/knowledge/entries/${created.id}`).expect(204);
    state = (await o.agent.get("/knowledge").expect(200)).body;
    expect(state).toMatchObject({ entries: [], published: { version: 2, entryCount: 1 }, changed: false });
    expect((await o.agent.get("/knowledge/versions/2").expect(200)).body.entries).toHaveLength(1);
  });

  it("refuses invalid entries and unknown versions", async () => {
    const o = await owner();
    await o.agent.post("/knowledge/entries").send({ kind: "faq", title: "Pets", body: "No.", fields: { price: 1 } }).expect(400);
    await o.agent.post("/knowledge/entries").send({ ...room, fields: { price: 3500, deposit: { mode: "percent", value: 500 } } }).expect(400);
    await o.agent.get("/knowledge/versions/7").expect(404);
  });

  it("keeps one workspace's sheet away from another's", async () => {
    const a = await owner();
    const b = await owner();
    const created = (await a.agent.post("/knowledge/entries").send(room).expect(201)).body;
    await a.agent.post("/knowledge/publish").expect(201);
    expect((await b.agent.get("/knowledge").expect(200)).body).toMatchObject({ entries: [], published: null });
    await b.agent.get("/knowledge/versions/1").expect(404);
    await b.agent.patch(`/knowledge/entries/${created.id}`).send(room).expect(404);
    await b.agent.delete(`/knowledge/entries/${created.id}`).send().expect(404);
  });

  it("saves and publishes arrival check-in and check-out times", async () => {
    const o = await owner();
    const arrival = { kind: "arrival", title: "Hours", body: "", fields: { checkInTime: "14:30", checkOutTime: "11:30" } };
    const created = (await o.agent.post("/knowledge/entries").send(arrival).expect(201)).body;
    expect(created.fields).toEqual({ checkInTime: "14:30", checkOutTime: "11:30" });
    await o.agent.post("/knowledge/publish").expect(201);
    const v1 = (await o.agent.get("/knowledge/versions/1").expect(200)).body;
    expect(v1.entries[0].fields).toEqual({ checkInTime: "14:30", checkOutTime: "11:30" });
  });
});
