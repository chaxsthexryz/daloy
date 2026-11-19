import { randomBytes } from "node:crypto";
import type { Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

// Review, "Before release" 2: separation from untrusted sibling sites. SameSite=Lax cookies are still sent from a
// sibling origin of the same site (evil.daloy.example.com to daloy.example.com), and a plain HTML form can post a
// urlencoded body, which the API parses. A signed-in change must therefore come from this installation's own origin.
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

const OWN = "https://daloy.example.com";
const SIBLING = "https://evil.daloy.example.com";
let seq = 0;
async function owner() {
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email: `site${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return agent;
}
const names = async (agent: ReturnType<typeof request.agent>) => ((await agent.get("/workflows").expect(200)).body as { name: string }[]).map((w) => w.name);

describe("a signed-in change from another origin", () => {
  it("is refused for a sibling origin, a foreign origin and the opaque origin, and changes nothing", async () => {
    const a = await owner();
    const wf = await a.post("/workflows").send({ name: "Mine", slug: "mine" }).expect(201);
    for (const origin of [SIBLING, "https://evil.example.org", "null", "http://daloy.example.com"]) {
      // A plain form post: no preflight, the cookie goes along, the body is urlencoded.
      await a.post("/workflows").set("Origin", origin).type("form").send({ name: "Planted", slug: "planted" }).expect(403);
      await a.post(`/workflows/${wf.body.id}/pause`).set("Origin", origin).expect(403);
      await a.put("/secrets/planted").set("Origin", origin).type("form").send({ value: "x" }).expect(403);
      await a.delete(`/workflows/${wf.body.id}`).set("Origin", origin).expect(403);
    }
    expect(await names(a)).toEqual(["Mine"]);
    expect((await a.get(`/workflows/${wf.body.id}`).expect(200)).body.pausedAt).toBeNull();
    expect((await a.get("/secrets").expect(200)).body).toEqual([]);
  });

  it("is accepted from this installation's own origin, from a client that sends no Origin, and from the host it was sent to", async () => {
    const a = await owner();
    await a.post("/workflows").set("Origin", OWN).send({ name: "Own origin", slug: "own" }).expect(201);
    await a.post("/workflows").send({ name: "No origin", slug: "none" }).expect(201);
    // Reached by another name than PUBLIC_URL (a LAN address, the Vite dev server): its own Host is its origin.
    await a.post("/workflows").set("Host", "daloy.lan:3000").set("Origin", "http://daloy.lan:3000").send({ name: "Same host", slug: "host" }).expect(201);
    expect(await names(a)).toEqual(expect.arrayContaining(["Own origin", "No origin", "Same host"]));
  });

  it("leaves reads, sign-in and public routes alone", async () => {
    const a = await owner();
    await a.get("/workflows").set("Origin", SIBLING).expect(200);
    await request(server).post("/auth/login").set("Origin", SIBLING).send({ email: "nobody@test.local", password: "wrong password" }).expect(401);
    await request(server).post("/forms/4039ded1-2916-43ae-b6fe-60d4ab2fa748").set("Origin", SIBLING).type("form").send({}).expect(404);
    // Signed out is still a 401, whatever the Origin.
    await request(server).post("/workflows").set("Origin", SIBLING).send({ name: "x", slug: "x" }).expect(401);
  });
});
