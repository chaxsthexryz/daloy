import { generateKeyPairSync, randomBytes } from "node:crypto";
import { connections, joinWorkspace, sessions, users, type Db } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";
import { sha256 } from "./http";

// Decision 0064: Google Calendar through "Connect with Google", against the fake's Google OAuth app.
let app: INestApplication;
let plain: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
const secretsKey = randomBytes(32);
const ANA = { id: "google-ana", email: "ana@clinic.example" };
const BEN = { id: "google-ben", email: "ben@clinic.example" };
let seq = 0;
type Agent = ReturnType<typeof request.agent>;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  const g = fake.addOAuthApp("google", { rotation: "none" });
  const googleOAuth = { clientId: g.clientId, clientSecret: g.clientSecret, ...fake.oauthUrls("google") };
  app = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "http://localhost:3000", providers: { ...fake.urls, timeoutMs: 2000, googleOAuth } });
  await app.init();
  server = app.getHttpServer();
  plain = await createApp({ db, boss, secretsKey, secureCookies: false, publicUrl: "http://localhost:3000", providers: { ...fake.urls, timeoutMs: 2000 } });
  await plain.init();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await plain?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

beforeEach(() => {
  Object.assign(fake.oauth.google!, { consent: "grant", user: ANA, revokeStatus: 200 });
});

async function owner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `calendar${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}
async function member(workspaceId: string, role: "operator" | "approver" | "requester") {
  const [u] = await db.insert(users).values({ email: `${role}${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}
/** Connect with Google: kymavo's start, the fake consent page, then the shared callback. Returns where the browser lands. */
async function connect(agent: Agent, who = ANA) {
  fake.oauth.google!.user = who;
  const { body } = await agent.post("/settings/connections/google-calendar/oauth/start").expect(200);
  const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
  return (await agent.get(back.pathname + back.search).expect(302)).headers.location as string;
}
const row = async (ws: string) => (await db.select().from(connections).where(eq(connections.userId, ws))).find((c) => c.provider === "google_calendar");

describe("Connect with Google for Calendar", () => {
  it("connects, makes the kymavo bookings calendar by itself, and shows the account without any token", async () => {
    const { agent, id } = await owner();
    expect(await connect(agent)).toBe("/#/apps/google-calendar-connected");
    const listed = (await agent.get("/settings/connections").expect(200)).body;
    expect(listed.oauth).toContain("google-calendar");
    expect(listed.connections).toEqual([expect.objectContaining({ provider: "google_calendar", authMethod: "oauth", account: ANA.email, destination: { calendarId: expect.stringContaining("@group.calendar.google.com"), title: "kymavo bookings" } })]);
    expect(JSON.stringify(listed)).not.toMatch(/google-(access|refresh)-/);
    expect(await row(id)).toMatchObject({ externalId: ANA.id, scopes: "openid email https://www.googleapis.com/auth/calendar.app.created" });
  });

  it("saves nothing on a decline or a missing scope", async () => {
    const { agent, id } = await owner();
    fake.oauth.google!.consent = "declined";
    expect(await connect(agent)).toBe("/#/apps/google-calendar-declined");
    Object.assign(fake.oauth.google!, { consent: "narrow", grantScopes: ["openid", "email"] });
    expect(await connect(agent)).toBe("/#/apps/google-calendar-missing_scope");
    expect(await row(id)).toBeUndefined();
  });

  it("makes the calendar once for the same account and a new one for another account", async () => {
    const { agent, id } = await owner();
    await connect(agent);
    const first = (await row(id))!.destination!;
    await connect(agent);
    expect((await row(id))!.destination).toEqual(first);
    expect(await connect(agent, BEN)).toBe("/#/apps/google-calendar-connected");
    const second = (await row(id))!;
    expect(second).toMatchObject({ account: BEN.email, externalId: BEN.id });
    expect(second.destination!.calendarId).not.toBe(first.calendarId);
    expect(fake.calendar(first.calendarId!)).toBeDefined();
  });

  it("still connects when Google refuses the calendar, and Create the calendar finishes it", async () => {
    const { agent, id } = await owner();
    fake.once("/calendar/v3/calendars", { status: 500, body: {} });
    expect(await connect(agent)).toBe("/#/apps/google-calendar-connected");
    expect((await row(id))!.destination).toBeNull();
    expect((await agent.post("/settings/connections/google-calendar/test").expect(200)).body).toMatchObject({ ok: false });
    const made = (await agent.post("/settings/connections/google-calendar/create").send({}).expect(200)).body;
    expect(made).toMatchObject({ title: "kymavo bookings" });
    expect((await row(id))!.destination).toEqual(made);
    // Pressed again, it keeps the calendar; asked to replace it, it makes a new one.
    expect((await agent.post("/settings/connections/google-calendar/create").send({}).expect(200)).body).toEqual(made);
    const again = (await agent.post("/settings/connections/google-calendar/create").send({ again: true }).expect(200)).body;
    expect(again.calendarId).not.toBe(made.calendarId);
    await agent.post("/settings/connections/google-calendar/create").send({ again: "yes" }).expect(400);
    await agent.post("/settings/connections/google-calendar/create").send({ extra: 1 }).expect(400);
  });

  it("adds a test event through the grant and removes it, and marks the connection failed when Google refuses the grant", async () => {
    const { agent, id } = await owner();
    await connect(agent);
    const { calendarId } = (await row(id))!.destination!;
    expect((await agent.post("/settings/connections/google-calendar/test").expect(200)).body).toMatchObject({ ok: true, created: true, deleted: true });
    expect([...fake.calendar(calendarId!)!.events.values()].map((e) => e.status)).toEqual(["cancelled"]);
    fake.oauth.google!.refreshTokens.clear();
    fake.oauth.google!.accessTokens.clear();
    expect((await agent.post("/settings/connections/google-calendar/test").expect(200)).body).toMatchObject({ ok: false });
    expect((await row(id))!.status).toBe("failed");
  });

  it("offers no Connect with Google on an installation without the client", async () => {
    const agent = request.agent(plain.getHttpServer());
    await agent.post("/auth/register").send({ email: `plain${++seq}@test.local`, password: "correct horse battery" }).expect(201);
    expect((await agent.get("/settings/connections").expect(200)).body.oauth).toEqual([]);
    await agent.post("/settings/connections/google-calendar/oauth/start").expect(400);
  });
});

describe("the service account form", () => {
  it("still works, replaces a Google sign-in, and cannot use the create route", async () => {
    const { agent, id } = await owner();
    await connect(agent);
    const email = "calendar@clinic.iam.gserviceaccount.com";
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    fake.addServiceAccount(email, publicKey.export({ type: "spki", format: "pem" }).toString());
    const calendarId = `sa${++seq}@group.calendar.google.com`;
    fake.addCalendar(calendarId, "Clinic bookings", [email]);
    const serviceAccount = JSON.stringify({ client_email: email, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    const saved = (await agent.put("/settings/connections/google-calendar").send({ serviceAccount, calendar: calendarId }).expect(200)).body;
    expect(saved.connections).toEqual([expect.objectContaining({ provider: "google_calendar", authMethod: "service_account", account: email, destination: { calendarId, title: "Clinic bookings" } })]);
    expect((await agent.post("/settings/connections/google-calendar/test").expect(200)).body).toMatchObject({ ok: true });
    await agent.post("/settings/connections/google-calendar/create").send({}).expect(400);
    expect((await row(id))).toMatchObject({ authMethod: "service_account", externalId: null });
    expect((await agent.delete("/settings/connections/google-calendar").expect(204)).body).toEqual({});
  });
});

describe("roles, logs and Disconnect", () => {
  it("lets only an owner start, create and disconnect, and signed-out callers nothing", async () => {
    const { agent, id } = await owner();
    await connect(agent);
    const roles = { operator: await member(id, "operator"), approver: await member(id, "approver"), requester: await member(id, "requester") };
    for (const who of Object.values(roles)) {
      await who.post("/settings/connections/google-calendar/oauth/start").expect(403);
      await who.post("/settings/connections/google-calendar/create").send({}).expect(403);
      await who.post("/settings/connections/google-calendar/test").expect(403);
      await who.delete("/settings/connections/google-calendar").expect(403);
    }
    await request(server).post("/settings/connections/google-calendar/oauth/start").expect(401);
    await request(server).post("/settings/connections/google-calendar/create").send({}).expect(401);
    expect(await row(id)).toBeDefined();
  });

  it("logs no token while connecting, creating the calendar and testing", async () => {
    const { agent } = await owner();
    const out: string[] = [];
    const record = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    const spies = [vi.spyOn(console, "log").mockImplementation(record), vi.spyOn(console, "error").mockImplementation(record), vi.spyOn(console, "warn").mockImplementation(record), vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true))];
    try {
      fake.once("/calendar/v3/calendars", { status: 500, body: { error: "echo google-access-leak" } });
      await connect(agent);
      await agent.post("/settings/connections/google-calendar/create").send({}).expect(200);
      await agent.post("/settings/connections/google-calendar/test").expect(200);
      expect(out.join("\n")).not.toMatch(/google-(access|refresh)-/);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("deletes the grant, then revokes it at Google", async () => {
    const { agent, id } = await owner();
    await connect(agent);
    const before = fake.oauth.google!.revoked.length;
    expect((await agent.delete("/settings/connections/google-calendar").expect(200)).body).toEqual({ revoked: true });
    expect(fake.oauth.google!.revoked.length).toBe(before + 1);
    expect(await row(id)).toBeUndefined();
  });
});
