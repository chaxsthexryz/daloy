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
import { GOOGLE_PICKER_CSP } from "./google";
import { sha256 } from "./http";

// Decision 0060: Google Sheets and Drive through "Connect with Google", against the fake's Google OAuth app.
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
  const googleOAuth = { clientId: g.clientId, clientSecret: g.clientSecret, ...fake.oauthUrls("google"), pickerApiKey: "picker-key-synthetic", projectNumber: "123456789012" };
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
  const res = await agent.post("/auth/register").send({ email: `google${++seq}@test.local`, password: "correct horse battery" }).expect(201);
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
async function connect(agent: Agent, slug = "google-sheets", who = ANA) {
  fake.oauth.google!.user = who;
  const { body } = await agent.post(`/settings/connections/${slug}/oauth/start`).expect(200);
  expect(body.url).toContain("access_type=offline");
  const back = new URL((await fetch(body.url as string, { redirect: "manual" })).headers.get("location")!);
  return (await agent.get(back.pathname + back.search).expect(302)).headers.location as string;
}
const row = async (ws: string, provider: "google_sheets" | "google_drive" = "google_sheets") => (await db.select().from(connections).where(eq(connections.userId, ws))).find((c) => c.provider === provider);
const sheetId = () => `picked-sheet-${String(++seq).padStart(6, "0")}`;

describe("Connect with Google", () => {
  it("connects Sheets, lists Google as configured, and shows the account and sign-in kind without any token", async () => {
    const { agent, id } = await owner();
    expect(await connect(agent)).toBe("/#/apps/google-sheets-connected");
    const listed = (await agent.get("/settings/connections").expect(200)).body;
    expect(listed.oauth).toEqual(expect.arrayContaining(["google-sheets", "google-drive"]));
    expect(listed.connections).toEqual([expect.objectContaining({ provider: "google_sheets", authMethod: "oauth", account: ANA.email, destination: null })]);
    expect(JSON.stringify(listed)).not.toMatch(/google-(access|refresh)-/);
    expect(await row(id)).toMatchObject({ externalId: ANA.id, scopes: "openid email https://www.googleapis.com/auth/drive.file" });
  });

  it("saves nothing on a decline or when drive.file was unticked", async () => {
    const { agent, id } = await owner();
    fake.oauth.google!.consent = "declined";
    expect(await connect(agent)).toBe("/#/apps/google-sheets-declined");
    Object.assign(fake.oauth.google!, { consent: "narrow", grantScopes: ["openid", "email"] });
    expect(await connect(agent)).toBe("/#/apps/google-sheets-missing_scope");
    expect(await row(id)).toBeUndefined();
  });

  it("keeps the sheet on a reconnect with the same account and clears it for another account", async () => {
    const { agent, id } = await owner();
    await connect(agent);
    await agent.post("/settings/connections/google-sheets/create").expect(200);
    await connect(agent);
    expect((await row(id))!.destination).toMatchObject({ title: "kymavo requests" });
    expect(await connect(agent, "google-sheets", BEN)).toBe("/#/apps/google-sheets-connected");
    expect(await row(id)).toMatchObject({ account: BEN.email, externalId: BEN.id, destination: null });
  });

  it("offers no Connect with Google on an installation without the client", async () => {
    const agent = request.agent(plain.getHttpServer());
    await agent.post("/auth/register").send({ email: `plain${++seq}@test.local`, password: "correct horse battery" }).expect(201);
    expect((await agent.get("/settings/connections").expect(200)).body.oauth).toEqual([]);
    await agent.post("/settings/connections/google-sheets/oauth/start").expect(400);
  });
});

describe("choosing the sheet", () => {
  it("creates kymavo requests, offers its real tabs, and adds a test row through the grant", async () => {
    const { agent, id } = await owner();
    await connect(agent);
    const made = (await agent.post("/settings/connections/google-sheets/create").expect(200)).body;
    expect(made).toMatchObject({ title: "kymavo requests", tabs: ["Sheet1"], tab: "Sheet1" });
    expect((await row(id))!.destination).toEqual({ spreadsheetId: made.spreadsheetId, tab: "Sheet1", title: "kymavo requests" });
    expect((await agent.get("/settings/connections/google-sheets/tabs").expect(200)).body).toEqual({ title: "kymavo requests", tabs: ["Sheet1"] });
    expect((await agent.post("/settings/connections/google-sheets/test").expect(200)).body).toMatchObject({ ok: true });
    expect(fake.sheet(made.spreadsheetId)!.tabs.get("Sheet1")).toHaveLength(1);
  });

  it("re-reads a picked id with kymavo's own grant and refuses one the grant cannot reach (R12)", async () => {
    const { agent, id } = await owner();
    await connect(agent);
    const theirs = sheetId();
    fake.addSheet(theirs, "Payroll", "Salaries", ["someone@else.example"]);
    const refused = await agent.post("/settings/connections/google-sheets/pick").send({ spreadsheetId: theirs }).expect(400);
    expect(refused.body.message).toMatch(/pick the sheet again/);
    expect((await row(id))!.destination).toBeNull();
    const picked = sheetId();
    fake.addSheet(picked, "Front desk", "Requests", [ANA.email]).tabs.set("Archive", []);
    await agent.post("/settings/connections/google-sheets/pick").send({ spreadsheetId: picked, tab: "Nope" }).expect(400);
    expect((await agent.post("/settings/connections/google-sheets/pick").send({ spreadsheetId: picked, tab: "Archive" }).expect(200)).body).toMatchObject({ tabs: ["Requests", "Archive"], tab: "Archive" });
    expect((await row(id))!.destination).toEqual({ spreadsheetId: picked, tab: "Archive", title: "Front desk" });
    await agent.post("/settings/connections/google-sheets/pick").send({ spreadsheetId: "../etc" }).expect(400);
    await agent.post("/settings/connections/google-sheets/pick").send({ spreadsheetId: picked, extra: 1 }).expect(400);
  });

  it("keeps the service account path, and refuses picks and creates on it", async () => {
    const { agent } = await owner();
    const email = "sheets@clinic.iam.gserviceaccount.com";
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    fake.addServiceAccount(email, publicKey.export({ type: "spki", format: "pem" }).toString());
    const id = sheetId();
    fake.addSheet(id, "Shared sheet", "Requests", [email]);
    const serviceAccount = JSON.stringify({ client_email: email, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    const saved = (await agent.put("/settings/connections/google-sheets").send({ serviceAccount, sheet: id, tab: "Requests" }).expect(200)).body;
    expect(saved.connections).toEqual([expect.objectContaining({ provider: "google_sheets", authMethod: "service_account", account: email })]);
    expect((await agent.post("/settings/connections/google-sheets/test").expect(200)).body).toMatchObject({ ok: true });
    await agent.post("/settings/connections/google-sheets/create").expect(400);
    await agent.post("/settings/connections/google-sheets/picker-token").expect(400);
    expect((await agent.delete("/settings/connections/google-sheets").expect(204)).body).toEqual({});
  });
});

describe("the Picker token", () => {
  it("answers only the owner, never cached, with the public key and app id, and logs no token", async () => {
    const { agent, id } = await owner();
    await connect(agent);
    const out: string[] = [];
    const record = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    const spies = [vi.spyOn(console, "log").mockImplementation(record), vi.spyOn(console, "error").mockImplementation(record), vi.spyOn(console, "warn").mockImplementation(record), vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true))];
    try {
      const res = await agent.post("/settings/connections/google-sheets/picker-token").expect(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual({ accessToken: expect.stringMatching(/^google-access-/), expiresAt: expect.any(Number), apiKey: "picker-key-synthetic", appId: "123456789012" });
      expect(fake.oauth.google!.accessTokens.has(res.body.accessToken)).toBe(true);
      const roles = { operator: await member(id, "operator"), approver: await member(id, "approver"), requester: await member(id, "requester") };
      for (const agentFor of Object.values(roles)) await agentFor.post("/settings/connections/google-sheets/picker-token").expect(403);
      await request(server).post("/settings/connections/google-sheets/picker-token").expect(401);
      await agent.post("/settings/connections/google-calendar/picker-token").expect(400);
      expect(out.join("\n")).not.toContain(res.body.accessToken);
      expect(out.join("\n")).not.toMatch(/google-(access|refresh)-/);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("is refused before Google is connected", async () => {
    const { agent } = await owner();
    await agent.post("/settings/connections/google-drive/picker-token").expect(404);
  });
});

describe("Drive", () => {
  it("creates a kymavo uploads folder in My Drive, takes a picked My Drive folder, and refuses one never picked", async () => {
    const { agent, id } = await owner();
    expect(await connect(agent, "google-drive")).toBe("/#/apps/google-drive-connected");
    const made = (await agent.post("/settings/connections/google-drive/create").expect(200)).body;
    expect(made).toMatchObject({ title: "kymavo uploads" });
    expect(fake.driveFolder(made.folderId)).toMatchObject({ sharedDriveId: null });
    fake.addDriveFolder("my-drive-folder-02", "Patient files", [ANA.email], null);
    expect((await agent.post("/settings/connections/google-drive/pick").send({ folderId: "my-drive-folder-02" }).expect(200)).body).toEqual({ folderId: "my-drive-folder-02", title: "Patient files" });
    expect((await row(id, "google_drive"))!.destination).toEqual({ folderId: "my-drive-folder-02", title: "Patient files" });
    fake.addDriveFolder("their-folder-0003", "Theirs", ["someone@else.example"], null);
    expect((await agent.post("/settings/connections/google-drive/pick").send({ folderId: "their-folder-0003" }).expect(400)).body.message).toMatch(/pick the folder again/);
  });
});

describe("Disconnect", () => {
  it("deletes the grant, then revokes it at Google", async () => {
    const { agent, id } = await owner();
    await connect(agent);
    const before = fake.oauth.google!.revoked.length;
    expect((await agent.delete("/settings/connections/google-sheets").expect(200)).body).toEqual({ revoked: true });
    expect(fake.oauth.google!.revoked.length).toBe(before + 1);
    expect(await row(id)).toBeUndefined();
  });
});

describe("console content security policy", () => {
  const directives = (header: string) => Object.fromEntries(header.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));
  it("adds only the Picker's Google hosts when the Picker is set up, and nothing without it", async () => {
    const withPicker = directives((await request(server).get("/auth/me")).headers["content-security-policy"] as string);
    const without = directives((await request(plain.getHttpServer()).get("/auth/me")).headers["content-security-policy"] as string);
    expect(without["script-src"]).toEqual(["'self'"]);
    expect(without["frame-src"]).toBeUndefined();
    expect(withPicker["script-src"]).toEqual(["'self'", ...GOOGLE_PICKER_CSP.scriptSrc]);
    expect(withPicker["frame-src"]).toEqual(["'self'", ...GOOGLE_PICKER_CSP.frameSrc]);
    expect(GOOGLE_PICKER_CSP).toEqual({ scriptSrc: ["https://apis.google.com"], frameSrc: ["https://docs.google.com", "https://drive.google.com"] });
    // Every other directive is exactly the default.
    const others = (d: Record<string, string[]>) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== "script-src" && k !== "frame-src"));
    expect(others(withPicker)).toEqual(others(without));
  });
});
