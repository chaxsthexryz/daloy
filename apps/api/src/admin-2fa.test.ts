import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { adminActions, adminRecoveryCodes, joinWorkspace, mailDeps, sessions, users, type Db } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { AdminController } from "./admin";
import { createApp } from "./app";
import { AdminFeedbackController } from "./feedback";
import { sha256 } from "./http";
import { base32Decode, totpAt } from "./totp";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
const PASSWORD = "correct horse battery";
const ADMIN_HOST = "admin.kymavo.test";
const MAIN = "kymavo.test";
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
const ADMINS = ["boss@daloy.test", "ops@daloy.test", "night@daloy.test", "spare@daloy.test", "routes@daloy.test", "enroll@daloy.test", "replay@daloy.test", "limit@daloy.test", "recover@daloy.test", "reset@daloy.test"];

beforeAll(async () => {
  const dist = mkdtempSync(join(tmpdir(), "daloy-web-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>workspace console</title>");
  writeFileSync(join(dist, "admin.html"), "<!doctype html><title>admin console</title>");
  writeFileSync(join(dist, "logo.svg"), "<svg/>");
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  // One proxy (cloudflared) in front, as in production, so X-Forwarded-Proto decides https.
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: true, trustProxy: 1, mail: mailDeps({}), publicUrl: `https://${MAIN}`, platformAdmins: ADMINS.join(","), webDist: dist, adminHost: ADMIN_HOST });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterEach(() => vi.useRealTimers());

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

type Method = "get" | "post" | "put" | "delete";
/** A browser on one host: every request carries that Host, https from cloudflared, and the page's own Origin on writes. */
function browserOn(host: string, cookie?: string) {
  const call = (method: Method, path: string) => {
    const r = request(server)[method](path).set("Host", host).set("X-Forwarded-Proto", "https");
    if (method !== "get") r.set("Origin", `https://${host}`);
    return cookie ? r.set("Cookie", cookie) : r;
  };
  return { get: (p: string) => call("get", p), post: (p: string) => call("post", p), put: (p: string) => call("put", p), delete: (p: string) => call("delete", p) };
}

let seq = 0;
async function account(email = `owner${++seq}@test.local`) {
  const [u] = await db.insert(users).values({ email, passwordHash: await hash(PASSWORD) }).returning();
  await joinWorkspace(db, u!.id, u!.id, "owner");
  return u!.id;
}

/** A live session straight in the database, so the tests stay under the sign-in rate limit. */
async function session(userId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId, expiresAt: new Date(Date.now() + 3_600_000) });
  return { cookie: `daloy_session=${token}`, hash: sha256(token) };
}

async function adminSession(email: string) {
  const id = await account(email);
  const s = await session(id);
  return { id, email, ...s, admin: browserOn(ADMIN_HOST, s.cookie) };
}

/** A clock that moves one 30-second step per code, so each code is fresh and the TOTP window still holds. */
function codes(secret: string) {
  const key = base32Decode(secret);
  let now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  return () => {
    now += 30_000;
    vi.setSystemTime(now);
    return totpAt(key, now);
  };
}

async function enroll(a: Awaited<ReturnType<typeof adminSession>>) {
  const { secret, uri } = (await a.admin.post("/admin/2fa/enroll").expect(200)).body as { secret: string; uri: string };
  const next = codes(secret);
  const { recoveryCodes } = (await a.admin.post("/admin/2fa/enroll/confirm").send({ code: next() }).expect(200)).body as { recoveryCodes: string[] };
  return { secret, uri, next, recoveryCodes };
}

const actions = (email: string) => db.select().from(adminActions).where(eq(adminActions.adminEmail, email));

describe("ADMIN_HOST routing", () => {
  it("serves the admin console at / on the admin host to anyone, uncached, and never the workspace console", async () => {
    const visitor = browserOn(ADMIN_HOST);
    for (const path of ["/", "/index.html", "/admin", "/admin.html"]) {
      const res = await visitor.get(path).expect(200);
      expect(res.text).toContain("admin console");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect((await visitor.get("/logo.svg").expect(200)).headers["content-type"]).toMatch(/svg/);
  });

  it("answers the workspace API with 404 on the admin host, and keeps the sign-in routes", async () => {
    const owner = await account();
    const s = await session(owner);
    const there = browserOn(ADMIN_HOST, s.cookie);
    for (const path of ["/workflows", "/usage", "/settings", "/health", "/events", "/Auth/me", "/AUTH/login"]) await there.get(path).expect(404);
    await there.post("/auth/register").send({ email: "new@test.local", password: PASSWORD }).expect(404);
    await there.post("/hooks/x").send({}).expect(404);
    await there.get("/auth/me").expect(200);
    // The same session on the main host reaches the workspace API.
    await browserOn(MAIN, s.cookie).get("/workflows").expect(200);
  });

  it("answers /admin and every admin API route with 404 on the main host, even for an enrolled and checked admin", async () => {
    const a = await adminSession("boss@daloy.test");
    await enroll(a);
    await a.admin.get("/admin/overview").expect(200);
    const main = browserOn(MAIN, a.cookie);
    for (const path of ["/admin", "/admin/", "/admin.html", "/ADMIN.HTML", "/admin%2Ehtml", "/admin/overview", "/ADMIN/overview", "//admin/overview", "/admin/2fa"]) {
      const res = await main.get(path).expect(404);
      expect(res.text).not.toContain("admin console");
    }
    await main.put("/admin/workspaces/00000000-0000-4000-8000-000000000000/plan").send({ plan: null }).expect(404);
    expect((await main.get("/").expect(200)).text).toContain("workspace console");
    // Unset hosts and look-alikes count as the main host.
    for (const host of ["127.0.0.1", "admin.kymavo.test.evil.example", "evil.example"]) await browserOn(host, a.cookie).get("/admin/overview").expect(404);
  });

  it("reads the host from Host alone, never from X-Forwarded-Host", async () => {
    const a = await adminSession("ops@daloy.test");
    await browserOn(MAIN, a.cookie).get("/admin/2fa").set("X-Forwarded-Host", ADMIN_HOST).expect(404);
    await browserOn(ADMIN_HOST, a.cookie).get("/admin/2fa").set("X-Forwarded-Host", MAIN).expect(200);
    await browserOn(ADMIN_HOST, a.cookie).get("/workflows").set("X-Forwarded-Host", MAIN).expect(404);
  });

  it("takes admin changes only from https://<ADMIN_HOST>, with an Origin header", async () => {
    const a = await adminSession("night@daloy.test");
    await enroll(a);
    const target = await account();
    const put = () => request(server).put(`/admin/workspaces/${target}/plan`).set("Host", ADMIN_HOST).set("X-Forwarded-Proto", "https").set("Cookie", a.cookie);
    for (const origin of [`https://${MAIN}`, `http://${ADMIN_HOST}`, "https://evil.example", "null"]) await put().set("Origin", origin).send({ plan: "pilot" }).expect(403);
    await put().send({ plan: "pilot" }).expect(403);
    await put().set("Origin", ADMIN_ORIGIN).send({ plan: "pilot" }).expect(200);
    // The same lock covers the two-factor routes.
    await request(server).post("/admin/2fa/verify").set("Host", ADMIN_HOST).set("Cookie", a.cookie).set("Origin", `https://${MAIN}`).send({ code: "123456" }).expect(403);
  });

  it("signs in on the admin host with a host-only cookie", async () => {
    await account("signin@test.local");
    const res = await browserOn(ADMIN_HOST).post("/auth/login").send({ email: "signin@test.local", password: PASSWORD }).expect(200);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/^daloy_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("tells the workspace console where an admin's console lives", async () => {
    await account("spare@daloy.test");
    const res = await browserOn(MAIN).post("/auth/login").send({ email: "spare@daloy.test", password: PASSWORD }).expect(200);
    expect(res.body).toMatchObject({ admin: true, adminUrl: `https://${ADMIN_HOST}/` });
    const other = await account();
    const s = await session(other);
    expect((await browserOn(MAIN, s.cookie).get("/auth/me").expect(200)).body).not.toHaveProperty("adminUrl");
  });
});

describe("two-factor sign-in for platform admins", () => {
  it("sends an admin who has not enrolled to setup on every admin route", async () => {
    const a = await adminSession("routes@daloy.test");
    const id = "00000000-0000-4000-8000-000000000000";
    const routes: [Method, string][] = [];
    for (const controller of [AdminController, AdminFeedbackController]) {
      const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as unknown as Record<string, object>)[name]!;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (path === undefined || name === "constructor") continue;
        const method = (["get", "post", "put", "delete", "patch"] as const)[Reflect.getMetadata(METHOD_METADATA, handler) as number] as Method;
        routes.push([method, `/${base}/${path}`.replace(/\/+$/, "").replace(/:id/g, id)]);
      }
    }
    expect(routes.length).toBeGreaterThan(8);
    for (const [method, path] of routes) {
      const res = await a.admin[method](path).send({});
      expect([path, res.status, res.body.twoFactor]).toEqual([path, 403, "setup"]);
    }
    expect((await a.admin.get("/admin/2fa").expect(200)).body).toMatchObject({ enrolled: false, verified: false });

    const { next } = await enroll(a);
    await a.admin.get("/admin/overview").expect(200);
    // Another session of the same admin has not passed the check; nor has this one after 12 hours.
    const other = browserOn(ADMIN_HOST, (await session(a.id)).cookie);
    for (const [method, path] of routes) expect((await other[method](path).send({})).body.twoFactor).toBe("verify");
    await db.update(sessions).set({ secondFactorAt: sql`now() - interval '12 hours 1 minute'` }).where(eq(sessions.idHash, a.hash));
    expect((await a.admin.get("/admin/overview").expect(403)).body.twoFactor).toBe("verify");
    await a.admin.post("/admin/2fa/verify").send({ code: next() }).expect(204);
    await a.admin.get("/admin/overview").expect(200);
  });

  it("enrolls with an encrypted secret confirmed by one code, and gives out ten hashed recovery codes once", async () => {
    const owner = browserOn(ADMIN_HOST, (await session(await account())).cookie);
    await owner.post("/admin/2fa/enroll").expect(404);
    await owner.get("/admin/2fa").expect(404);

    const a = await adminSession("enroll@daloy.test");
    const first = (await a.admin.post("/admin/2fa/enroll").expect(200)).body as { secret: string; uri: string };
    expect(first.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(first.uri).toBe(`otpauth://totp/kymavo%20admin:enroll%40daloy.test?secret=${first.secret}&issuer=kymavo%20admin&algorithm=SHA1&digits=6&period=30`);
    // Starting again replaces the unconfirmed secret.
    const { secret } = (await a.admin.post("/admin/2fa/enroll").expect(200)).body as { secret: string };
    expect(secret).not.toBe(first.secret);
    const { rows } = await pool.query("select ciphertext, iv, auth_tag, confirmed_at from admin_totp where user_id = $1", [a.id]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[0].confirmed_at).toBeNull();
    // Not enrolled until a code confirms it.
    expect((await a.admin.get("/admin/overview").expect(403)).body.twoFactor).toBe("setup");

    const next = codes(secret);
    await a.admin.post("/admin/2fa/enroll/confirm").send({ code: totpAt(base32Decode(first.secret), Date.now()) }).expect(400);
    const { recoveryCodes } = (await a.admin.post("/admin/2fa/enroll/confirm").send({ code: next() }).expect(200)).body as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const c of recoveryCodes) expect(c).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    const stored = await db.select().from(adminRecoveryCodes).where(eq(adminRecoveryCodes.userId, a.id));
    expect(stored).toHaveLength(10);
    for (const r of stored) expect(r.codeHash).toMatch(/^\$argon2/);
    expect(JSON.stringify(stored)).not.toContain(recoveryCodes[0]!.replace("-", ""));

    expect((await a.admin.get("/admin/2fa").expect(200)).body).toMatchObject({ enrolled: true, verified: true, consoleUrl: `https://${MAIN}` });
    await a.admin.get("/admin/overview").expect(200);
    // Shown once: there is no way to enroll or confirm again without a reset.
    await a.admin.post("/admin/2fa/enroll").expect(409);
    await a.admin.post("/admin/2fa/enroll/confirm").send({ code: next() }).expect(409);
    expect((await actions(a.email)).map((r) => [r.action, r.after])).toContainEqual(["2fa_enroll", { recoveryCodes: 10 }]);
  });

  it("accepts each code once and refuses a wrong one, logging the failure without the code", async () => {
    const a = await adminSession("replay@daloy.test");
    const { secret } = (await a.admin.post("/admin/2fa/enroll").expect(200)).body as { secret: string };
    const next = codes(secret);
    const confirmCode = next();
    await a.admin.post("/admin/2fa/enroll/confirm").send({ code: confirmCode }).expect(200);
    const later = browserOn(ADMIN_HOST, (await session(a.id)).cookie);
    await later.post("/admin/2fa/verify").send({ code: confirmCode }).expect(400);
    const fresh = next();
    await later.post("/admin/2fa/verify").send({ code: fresh }).expect(204);
    await browserOn(ADMIN_HOST, (await session(a.id)).cookie).post("/admin/2fa/verify").send({ code: fresh }).expect(400);
    for (const bad of [{ code: "12345" }, { code: "abcdef" }, { code: "123456", extra: 1 }, {}]) await later.post("/admin/2fa/verify").send(bad).expect(400);

    const failed = (await actions(a.email)).filter((r) => r.action === "2fa_failed");
    expect(failed.map((r) => [r.workspaceId, r.before, r.after])).toEqual([
      [null, {}, { kind: "totp", during: "verify" }],
      [null, {}, { kind: "totp", during: "verify" }],
    ]);
    expect(JSON.stringify(await actions(a.email))).not.toContain(confirmCode);
  });

  it("refuses every check after five wrong codes in 15 minutes, even a right one", async () => {
    const a = await adminSession("limit@daloy.test");
    const { next, recoveryCodes } = await enroll(a);
    const other = browserOn(ADMIN_HOST, (await session(a.id)).cookie);
    for (let i = 0; i < 5; i++) await other.post("/admin/2fa/verify").send({ code: "000000" }).expect(400);
    await other.post("/admin/2fa/verify").send({ code: next() }).expect(429);
    await other.post("/admin/2fa/verify").send({ recoveryCode: recoveryCodes[0] }).expect(429);
    await a.admin.post("/admin/2fa/reset").send({ code: next() }).expect(429);
    expect((await actions(a.email)).filter((r) => r.action === "2fa_failed")).toHaveLength(5);
    // Failures older than 15 minutes no longer count.
    await db.update(adminActions).set({ createdAt: sql`now() - interval '16 minutes'` }).where(and(eq(adminActions.adminEmail, a.email), eq(adminActions.action, "2fa_failed")));
    await other.post("/admin/2fa/verify").send({ code: next() }).expect(204);
  });

  it("takes a recovery code once, however it is typed, and marks it used", async () => {
    const a = await adminSession("recover@daloy.test");
    const { recoveryCodes } = await enroll(a);
    const typed = recoveryCodes[3]!.replace("-", " ").toUpperCase();
    const phoneLost = browserOn(ADMIN_HOST, (await session(a.id)).cookie);
    await phoneLost.post("/admin/2fa/verify").send({ recoveryCode: typed }).expect(204);
    await phoneLost.get("/admin/overview").expect(200);
    await browserOn(ADMIN_HOST, (await session(a.id)).cookie).post("/admin/2fa/verify").send({ recoveryCode: recoveryCodes[3] }).expect(400);
    await browserOn(ADMIN_HOST, (await session(a.id)).cookie).post("/admin/2fa/verify").send({ recoveryCode: "aaaaa-aaaaa" }).expect(400);
    expect(await db.select().from(adminRecoveryCodes).where(and(eq(adminRecoveryCodes.userId, a.id), isNotNull(adminRecoveryCodes.usedAt)))).toHaveLength(1);
    const rows = await actions(a.email);
    expect(rows.map((r) => [r.action, r.after])).toEqual(expect.arrayContaining([["2fa_recovery", { remaining: 9 }], ["2fa_failed", { kind: "recovery", during: "verify" }]]));
    expect(JSON.stringify(rows)).not.toContain(recoveryCodes[3]!.slice(0, 5));
  });

  it("resets only from a checked session with a fresh code, then asks to enroll again", async () => {
    const a = await adminSession("reset@daloy.test");
    const { next } = await enroll(a);
    const unchecked = browserOn(ADMIN_HOST, (await session(a.id)).cookie);
    expect((await unchecked.post("/admin/2fa/reset").send({ code: next() }).expect(403)).body.twoFactor).toBe("verify");
    await a.admin.post("/admin/2fa/reset").send({ code: "000000" }).expect(400);
    await a.admin.post("/admin/2fa/reset").send({ code: next() }).expect(204);
    expect((await a.admin.get("/admin/2fa").expect(200)).body).toMatchObject({ enrolled: false, verified: false });
    expect((await a.admin.get("/admin/overview").expect(403)).body.twoFactor).toBe("setup");
    expect(await db.select().from(adminRecoveryCodes).where(eq(adminRecoveryCodes.userId, a.id))).toHaveLength(0);
    expect((await actions(a.email)).map((r) => r.action)).toEqual(expect.arrayContaining(["2fa_enroll", "2fa_failed", "2fa_reset"]));
    // A new enrollment starts over, and the old check does not carry over to it.
    await enroll(a);
    await a.admin.get("/admin/overview").expect(200);
    await unchecked.get("/admin/overview").expect(403);
  });
});
