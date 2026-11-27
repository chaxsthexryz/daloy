import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { joinWorkspace, mailDeps, users, type Db } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
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
const PASSWORD = "correct horse battery";
const ADMIN = "boss@daloy.test";
const ADMIN_HTML = "<!doctype html><title>admin console</title>";

beforeAll(async () => {
  // A stand-in for apps/web/dist: the console at /, the admin console beside it.
  const dist = mkdtempSync(join(tmpdir(), "daloy-web-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>workspace console</title>");
  writeFileSync(join(dist, "admin.html"), ADMIN_HTML);
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, mail: mailDeps({}), platformAdmins: ADMIN, webDist: dist });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

async function signIn(email: string) {
  const [u] = await db.insert(users).values({ email, passwordHash: await hash(PASSWORD) }).returning();
  await joinWorkspace(db, u!.id, u!.id, "owner");
  const agent = request.agent(server);
  await agent.post("/auth/login").send({ email, password: PASSWORD }).expect(200);
  return agent;
}

describe("the admin console page at /admin", () => {
  it("answers a non-admin and a signed-out visitor with the admin API's own 404", async () => {
    const owner = await signIn("owner@test.local");
    const api = await owner.get("/admin/overview").expect(404);
    for (const agent of [owner, request(server)]) {
      for (const path of ["/admin", "/admin/", "/admin.html", "/ADMIN.HTML", "/admin%2Ehtml", "/x/../admin.html"]) {
        const res = await agent.get(path).expect(404);
        expect(res.body).toEqual(api.body);
        expect(res.text).not.toContain("admin console");
      }
    }
  });

  it("serves the admin console to a platform admin, uncached, and leaves the workspace console and admin API alone", async () => {
    const admin = await signIn(ADMIN);
    for (const path of ["/admin", "/admin/", "/admin.html"]) {
      const res = await admin.get(path).expect(200);
      expect(res.text).toBe(ADMIN_HTML);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect((await admin.get("/admin/overview").expect(200)).body).toHaveProperty("workspaces");
    expect((await request(server).get("/").expect(200)).text).toContain("workspace console");
  });
});
