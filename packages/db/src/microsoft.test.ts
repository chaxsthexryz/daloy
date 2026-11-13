import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { connectionCredential, readConnections, saveConnection } from "./connections";
import { confirmDelivery, queueDelivery, retryDelivery, runDueDeliveries } from "./deliveries";
import type { Db } from "./index";
import { consentOutcome, outlookAuthorizeUrl, outlookCodeTokens, teamsWebhookUrl, type ProviderUrls } from "./providers";
import { connections, deliveries, runs, users, workflows, workflowVersions } from "./schema";

// Roadmap phase 5 (decision 0023): Outlook mail and Teams notes are deliveries like Sheets and Slack. Expired access is
// refreshed, revoked access marks the connection failed, and a send that may have arrived waits for a person.
const key = randomBytes(32);
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let urls: ProviderUrls;
let ana: string;

async function newRun(userId: string) {
  const [wf] = await db.insert(workflows).values({ userId, name: "Purchase requests", slug: `w${randomBytes(4).toString("hex")}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
  return r!.id;
}
const mail = async (reference: string) =>
  queueDelivery(db, { userId: ana, runId: await newRun(ana), stepId: "tell_purchasing", provider: "outlook", reference, payload: { to: "purchasing@contoso.example", subject: `Approved ${reference}`, text: "Buy a chair." } });
const note = async (reference: string) => queueDelivery(db, { userId: ana, runId: await newRun(ana), stepId: "post_to_teams", provider: "teams", reference, payload: { text: `Purchase request ${reference} approved` } });
const state = async (id: string) => (await db.select().from(deliveries).where(eq(deliveries.id, id)))[0]!;
const deliverDue = () => runDueDeliveries(db, key, urls);
const makeDue = (id: string) => db.update(deliveries).set({ nextAttemptAt: sql`now()` }).where(eq(deliveries.id, id));

/** The real consent dance against the fake: authorize, then swap the code. Returns the refresh token Daloy would store. */
async function consent(): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const { createHash } = await import("node:crypto");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = "http://localhost:3000/settings/connections/outlook/callback";
  const res = await fetch(outlookAuthorizeUrl(urls, { redirectUri, state: "s", codeChallenge: challenge }), { redirect: "manual" });
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  return (await outlookCodeTokens(urls, code, verifier, redirectUri)).refreshToken;
}

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  urls = { ...fake.urls, timeoutMs: 300, microsoft: { clientId: fake.microsoft.clientId, clientSecret: fake.microsoft.clientSecret, tenant: "organizations" } };
  const [u] = await db.insert(users).values({ email: "ana@test.local", passwordHash: "x" }).returning();
  ana = u!.id;
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await pool?.end();
});

beforeEach(async () => {
  await db.delete(deliveries);
  await db.delete(connections);
  fake.microsoft.consent = "grant";
  fake.microsoft.mailboxEnabled = true;
  fake.microsoft.sent.length = 0;
  fake.teams.posts.length = 0;
  fake.teams.flows.add("flow-purchasing");
  await saveConnection(db, key, ana, "outlook", { account: "ana@contoso.example", credential: await consent(), destination: { mailbox: "ana@contoso.example" } });
  await saveConnection(db, key, ana, "teams", { account: "Purchasing", credential: fake.teamsUrl("flow-purchasing"), destination: { channelName: "Purchasing" } });
});

it("sends from the connected mailbox and stores the refresh token Microsoft rotated", async () => {
  const before = (await connectionCredential(db, key, ana, "outlook"))!.credential;
  const d = await mail("PUR-1001");
  await deliverDue();
  expect(await state(d.id)).toMatchObject({ state: "delivered", result: { to: "purchasing@contoso.example", sent: true } });
  expect(fake.microsoft.sent).toEqual([{ to: "purchasing@contoso.example", subject: "Approved PUR-1001", text: "Buy a chair." }]);
  expect((await connectionCredential(db, key, ana, "outlook"))!.credential).not.toBe(before);
});

it("signs in again once when the access token expired early", async () => {
  await mail("PUR-0000");
  await deliverDue(); // caches an access token
  fake.microsoft.sent.length = 0;
  fake.microsoft.accessTokens.clear();
  const d = await mail("PUR-1002");
  await deliverDue();
  expect((await state(d.id)).state).toBe("delivered");
  expect(fake.microsoft.sent).toHaveLength(1);
});

it("marks Outlook failed when access was revoked, and Reconnect plus Retry sends it once", async () => {
  fake.microsoft.refreshTokens.clear();
  fake.microsoft.accessTokens.clear();
  const d = await mail("PUR-1003");
  await deliverDue();
  expect(await state(d.id)).toMatchObject({ state: "failed" });
  expect((await state(d.id)).lastError).toMatch(/Reconnect Outlook/);
  const [conn] = (await readConnections(db, ana)).filter((c) => c.provider === "outlook");
  expect(conn).toMatchObject({ status: "failed" });

  await saveConnection(db, key, ana, "outlook", { account: "ana@contoso.example", credential: await consent(), destination: { mailbox: "ana@contoso.example" } });
  expect(await retryDelivery(db, ana, d.id)).toBe(true);
  await deliverDue();
  expect((await state(d.id)).state).toBe("delivered");
  expect(fake.microsoft.sent).toHaveLength(1);
});

it("fails without retrying when the mailbox may not send", async () => {
  fake.microsoft.mailboxEnabled = false;
  const d = await mail("PUR-1004");
  await deliverDue();
  const s = await state(d.id);
  expect(s).toMatchObject({ state: "failed", attempts: 1 });
  expect(s.lastError).toMatch(/refused to send/);
  expect((await readConnections(db, ana)).find((c) => c.provider === "outlook")).toMatchObject({ status: "active" });
});

it("backs off for Outlook's Retry-After and then sends", async () => {
  const d = await mail("PUR-1005");
  fake.once("/me/sendMail", { status: 429, body: { error: { code: "ApplicationThrottled", message: "Too many requests" } }, headers: { "retry-after": "30" } });
  await deliverDue();
  const s = await state(d.id);
  expect(s.state).toBe("queued");
  expect(s.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(25_000);
  await makeDue(d.id);
  await deliverDue();
  expect((await state(d.id)).state).toBe("delivered");
});

it("holds an Outlook send that timed out for review, and sends again only when asked", async () => {
  const d = await mail("PUR-1006");
  fake.once("/me/sendMail", "hang-after");
  await deliverDue();
  const s = await state(d.id);
  expect(s.state).toBe("needs_review");
  expect(s.lastError).toMatch(/Sent Items of ana@contoso.example/);
  expect(await retryDelivery(db, ana, d.id)).toBe(false); // plain Retry never repeats it
  expect(await retryDelivery(db, ana, d.id, { postAgain: true })).toBe(true);
  await deliverDue();
  expect((await state(d.id)).state).toBe("delivered");
  expect(fake.microsoft.sent).toHaveLength(2);
});

it("posts a Teams card with the text, and Mark as posted settles an uncertain one", async () => {
  const d = await note("PUR-1007");
  await deliverDue();
  expect(await state(d.id)).toMatchObject({ state: "delivered", result: { accepted: true } });
  expect(fake.teams.posts.map((p) => p.text)).toEqual(["Purchase request PUR-1007 approved"]);

  const e = await note("PUR-1008");
  fake.once("/teams/workflows/", "hang-after");
  await deliverDue();
  expect((await state(e.id)).state).toBe("needs_review");
  expect(await confirmDelivery(db, ana, e.id)).toBe(true);
  expect(await state(e.id)).toMatchObject({ state: "delivered", result: { confirmedBy: "operator" } });
});

it("marks Teams failed when the workflow was deleted", async () => {
  fake.teams.flows.delete("flow-purchasing");
  const d = await note("PUR-1009");
  await deliverDue();
  expect((await state(d.id)).lastError).toMatch(/deleted or turned off/);
  expect((await readConnections(db, ana)).find((c) => c.provider === "teams")).toMatchObject({ status: "failed" });
});

it("treats a Teams workflow that requires sign-in as a permission problem", async () => {
  const d = await note("PUR-1010");
  fake.once("/teams/workflows/", { status: 401, body: { error: { code: "DirectApiAuthorizationRequired" } } });
  await deliverDue();
  expect(await state(d.id)).toMatchObject({ state: "failed" });
  expect((await state(d.id)).lastError).toMatch(/Who can trigger the flow/);
});

it("accepts only Microsoft Workflows addresses for Teams", () => {
  const real = { ...urls, teamsHosts: ["logic.azure.com", "powerplatform.com"] };
  expect(teamsWebhookUrl(real, "https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x")).toBeTruthy();
  expect(teamsWebhookUrl(real, "https://default1.2b.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/x")).toBeTruthy();
  expect(teamsWebhookUrl(real, "http://prod-12.westus.logic.azure.com/workflows/abc")).toBeNull();
  expect(teamsWebhookUrl(real, "https://logic.azure.com.evil.example/workflows/abc")).toBeNull();
  expect(teamsWebhookUrl(real, "https://169.254.169.254/latest")).toBeNull();
  expect(teamsWebhookUrl(real, "http://127.0.0.1:9/teams")).toBeNull();
  expect(teamsWebhookUrl(real, "not a url")).toBeNull();
});

it("tells an administrator requirement apart from a person saying no", () => {
  expect(consentOutcome("access_denied", "AADSTS90094: The grant requires admin permission.")).toBe("admin_required");
  expect(consentOutcome("access_denied", "AADSTS65004: User declined to consent to access the app.")).toBe("declined");
  expect(consentOutcome("server_error", "")).toBe("failed");
});
