import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { deployEnv } from "./http";

// Read by auth.ts when it loads, so set before the imports run. A file of its own: the limits are per process.
vi.hoisted(() => {
  process.env.REGISTER_LIMIT_PER_HOUR = "3";
});

let proxied: INestApplication;
let direct: INestApplication;
let boss: PgBoss;
let pool: Pool;
let behindProxy: Parameters<typeof request>[0];
let noProxy: Parameters<typeof request>[0];

beforeAll(async () => {
  const { url, db, pool: p } = await freshDatabase();
  pool = p;
  boss = new PgBoss(url);
  await boss.start();
  // One proxy in front (cloudflared or Caddy), as in docs/deployment.md.
  proxied = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: true, trustProxy: 1 });
  direct = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await proxied.init();
  await direct.init();
  behindProxy = proxied.getHttpServer();
  noProxy = direct.getHttpServer();
}, 120_000);

afterAll(async () => {
  await proxied?.close();
  await direct?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

const login = (server: Parameters<typeof request>[0], xff?: string) => {
  const req = request(server).post("/auth/login");
  if (xff !== undefined) req.set("X-Forwarded-For", xff);
  return req.send({ email: "nobody@test.local", password: "wrong password" });
};
const exhaustLogin = async (server: Parameters<typeof request>[0], xff?: string) => {
  for (let i = 0; i < 10; i++) expect((await login(server, xff)).status).toBe(401);
  expect((await login(server, xff)).status).toBe(429);
};

describe("rate limits behind one proxy hop", () => {
  it("keeps a bucket per real client", async () => {
    await exhaustLogin(behindProxy, "203.0.113.1");
    expect((await login(behindProxy, "203.0.113.2")).status).toBe(401);
  });

  it("keys on the address the proxy saw, not on what the client wrote before it", async () => {
    await exhaustLogin(behindProxy, "203.0.113.3");
    // A client that sends its own X-Forwarded-For gets the proxy's entry appended to the right.
    expect((await login(behindProxy, "198.51.100.9, 203.0.113.3")).status).toBe(429);
    expect((await login(behindProxy, "203.0.113.3, 198.51.100.10")).status).toBe(401);
  });

  it("limits sign-ups per client", async () => {
    const register = (xff: string, n: number) =>
      request(behindProxy).post("/auth/register").set("X-Forwarded-For", xff).send({ email: `reg${n}-${xff}@test.local`, password: "correct horse battery" });
    for (let n = 0; n < 3; n++) expect((await register("203.0.113.20", n)).status).toBe(201);
    expect((await register("203.0.113.20", 3)).status).toBe(429);
    expect((await register("203.0.113.21", 0)).status).toBe(201);
  });

  it("sets a Secure session cookie", async () => {
    const res = await request(behindProxy).post("/auth/register").set("X-Forwarded-For", "203.0.113.30").send({ email: "secure@test.local", password: "correct horse battery" }).expect(201);
    expect(String(res.headers["set-cookie"])).toMatch(/; Secure/);
  });
});

describe("rate limits without a trusted proxy", () => {
  it("ignores X-Forwarded-For, so a client cannot pick a fresh bucket", async () => {
    await exhaustLogin(noProxy);
    expect((await login(noProxy, "203.0.113.50")).status).toBe(429);
  });

  it("leaves the cookie without Secure when secure cookies are off", async () => {
    const res = await request(noProxy).post("/auth/register").send({ email: "plain@test.local", password: "correct horse battery" }).expect(201);
    expect(String(res.headers["set-cookie"])).not.toMatch(/Secure/);
  });
});

describe("deployEnv", () => {
  it("reads the proxy hop count and the cookie flag", () => {
    expect(deployEnv({})).toEqual({ trustProxy: 0, secureCookies: false });
    expect(deployEnv({ TRUST_PROXY: "1", SECURE_COOKIES: "true" })).toEqual({ trustProxy: 1, secureCookies: true });
    expect(deployEnv({ TRUST_PROXY: "", SECURE_COOKIES: "false" })).toEqual({ trustProxy: 0, secureCookies: false });
  });

  it("turns secure cookies on in production", () => {
    expect(deployEnv({ NODE_ENV: "production" }).secureCookies).toBe(true);
    expect(deployEnv({ NODE_ENV: "production", SECURE_COOKIES: "false" }).secureCookies).toBe(true);
  });

  it("refuses values it cannot read, so a typo does not silently turn a protection off", () => {
    for (const TRUST_PROXY of ["abc", "-1", "1.5", "11", "true"]) expect(() => deployEnv({ TRUST_PROXY }), TRUST_PROXY).toThrow(/TRUST_PROXY/);
    for (const SECURE_COOKIES of ["yes", "1", "TRUE "]) expect(() => deployEnv({ SECURE_COOKIES }), SECURE_COOKIES).toThrow(/SECURE_COOKIES/);
  });
});
