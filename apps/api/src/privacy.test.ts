import { randomBytes, randomUUID } from "node:crypto";
import {
  bookingChanges, bookingResults, bookings, calendarEvents, createDue, deliveries, joinWorkspace, paymentClaims, paymentDues, paymentHistory, paymongoEvents, privacyRequests, receiptReferences, requests, resources, runs, sessions, stepRuns, submitTransferClaim, uploads, users, workflows, workflowVersions, type Db,
} from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";
import { sha256 } from "./http";
import { renderForm } from "./public";

// R6, decision 0094: the owner's export and delete of one customer's data, who may do it, and the notice on public forms.
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let server: Parameters<typeof request>[0];
let seq = 0;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, trustProxy: 1, publicUrl: "https://daloy.test", providers: { ...fake.urls, timeoutMs: 2000 } });
  await app.init();
  server = app.getHttpServer();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

async function owner() {
  const email = `r6-${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return { agent, userId: u!.id };
}

async function member(workspaceId: string, role: "operator" | "approver" | "requester") {
  const [u] = await db.insert(users).values({ email: `r6m-${++seq}@test.local`, passwordHash: "x" }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}

type Who = { name: string; email: string; phone: string; replyTo: string; ref: string };
const who = (name: string, email: string, phone: string, replyTo: string): Who => ({ name, email, phone, replyTo, ref: `REF${++seq}${name.replace(/\W/g, "").toUpperCase()}` });

/** One customer's trail through every table that holds what they sent. */
async function seed(ws: string, c: Who) {
  const [wf] = await db.insert(workflows).values({ userId: ws, name: "Intake", slug: `i-${++seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  const [run] = await db.insert(runs).values({ workflowVersionId: v!.id, state: "waiting", triggerPayload: { name: c.name, contact: { email: c.email.toUpperCase(), phone: c.phone }, note: "hello" }, error: `failed for ${c.email}` }).returning();
  const runId = run!.id;
  await db.insert(stepRuns).values({ runId, stepId: "ai", attempt: 1, state: "succeeded", input: { prompt: `Reply to ${c.name} at ${c.email}` }, output: { text: `Dear ${c.name}` }, error: `bad ${c.name}`, inputTokens: 12, outputTokens: 7 });
  await db.insert(uploads).values({ id: randomUUID(), userId: ws, runId, field: "id", name: `${c.name}.png`, type: "png", size: PNG.length, data: PNG });
  await db.insert(deliveries).values({ userId: ws, runId, stepId: "mail", provider: "outlook", reference: c.ref, payload: { to: c.email, subject: "Hi", text: `Hello ${c.name}` } });
  await db.insert(requests).values({ userId: ws, workflowId: wf!.id, runId, reference: c.ref, submissionKey: randomUUID(), subject: `Request from ${c.name}` });
  const [res] = await db.insert(resources).values({ userId: ws, name: `Room ${c.ref}` }).returning();
  const [b] = await db.insert(bookings).values({ userId: ws, test: false, reference: `B-${c.ref}`, resourceId: res!.id, during: "[2031-01-01 10:00+00,2031-01-01 11:00+00)", timezone: "Asia/Manila", runId, workflowId: wf!.id }).returning();
  await db.insert(bookingResults).values({ runId, stepId: "book", bookingId: b!.id, branch: "ok", output: { who: c.name, email: c.email } });
  await db.insert(bookingChanges).values({ bookingId: b!.id, fromVersion: 0, action: "create", runId, actor: `run:${runId}`, result: { version: 1, name: c.name } });
  await db.insert(calendarEvents).values({ bookingId: b!.id, userId: ws, title: `${c.name} haircut`, description: `${c.email} ${c.phone}` });
  const open = await createDue(db, { userId: ws, test: false, workflowId: wf!.id, runId, stepId: "ask", reference: `D-${c.ref}`, kind: "deposit", amountCentavos: 35000, bookingId: b!.id, replyChannel: "sms", replyTo: c.replyTo, replyText: `Hi ${c.name}, we got it` });
  await submitTransferClaim(db, open.token, { transferRef: `OPEN${c.ref}`, image: { bytes: PNG } });
  const done = await createDue(db, { userId: ws, test: false, workflowId: wf!.id, runId, stepId: "ask2", reference: `E-${c.ref}`, kind: "balance", amountCentavos: 10000, replyChannel: "sms", replyTo: c.replyTo, replyText: `Paid ${c.name}` });
  await db.update(paymentDues).set({ status: "confirmed", confirmedSource: "transfer", confirmedAt: new Date() }).where(eq(paymentDues.id, done.id));
  await db.insert(paymentClaims).values({ userId: ws, dueId: done.id, channel: "transfer", transferRef: `CONF${c.ref}`, normalizedRef: `CONF${c.ref}`, image: PNG, imageType: "png", imageSize: PNG.length, status: "confirmed" });
  await db.insert(paymentHistory).values({ userId: ws, dueId: done.id, event: "confirmed", source: "staff", detail: { amount: 10000, ref: `CONF${c.ref}` } });
  await db.insert(paymongoEvents).values({ eventId: `evt_${c.ref}`, userId: ws, type: "payment.paid", state: "kept", payload: { data: { attributes: { billing: { name: c.name, email: c.email, phone: c.replyTo } } } } });
  await db.insert(receiptReferences).values({ userId: ws, normalizedRef: `RR${c.ref}`, firstRunId: runId });
  return { runId, dues: [open.id, done.id], booking: b!.id };
}

async function dump() {
  const all = await Promise.all([runs, stepRuns, uploads, deliveries, requests, bookings, bookingResults, bookingChanges, calendarEvents, paymentDues, paymentClaims, paymentHistory, paymongoEvents, receiptReferences].map((t) => db.select().from(t as typeof runs)));
  return JSON.stringify(all);
}
const exportOf = (agent: request.Agent, q: string) => agent.get(`/privacy/customer?${q}`);
const del = (agent: request.Agent, body: unknown) => agent.post("/privacy/customer/delete").send(body as object);

describe("export", () => {
  it("has all of one customer's data and none of another's, found by email or by a phone in any format", async () => {
    const o = await owner();
    const a = who("Ana Reyes", "ana.reyes@export.test", "0917 123 4567", "+639171234567");
    const b = who("Ben Cruz", "ben.cruz@export.test", "0918 111 2222", "+639181112222");
    await seed(o.userId, a);
    await seed(o.userId, b);
    const res = await exportOf(o.agent, `email=${encodeURIComponent("Ana.Reyes@Export.test")}`).expect(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    const text = JSON.stringify(res.body);
    for (const s of [a.name, a.email.toUpperCase(), a.ref, "Dear Ana Reyes", "Ana Reyes haircut"]) expect(text).toContain(s);
    for (const s of [b.name, b.email, "0918 111 2222", "+639181112222", b.ref]) expect(text).not.toContain(s);
    expect(res.body.counts).toMatchObject({ runs: 1, stepRuns: 1, uploads: 1, deliveries: 1, requests: 1, bookings: 1, bookingResults: 1, bookingChanges: 1, calendarEvents: 1, dues: 2, claims: 2, paymongoEvents: 1, receiptReferences: 1 });
    expect(res.body.uploads[0].dataBase64).toBe(PNG.toString("base64"));
    expect(res.body.claims.every((c: { imageBase64: string | null }) => c.imageBase64 !== null)).toBe(true);
    for (const phone of ["0917 123 4567", "+639171234567", "639171234567", "917-123-4567"]) {
      const byPhone = await exportOf(o.agent, `phone=${encodeURIComponent(phone)}`).expect(200);
      expect(byPhone.body.counts).toEqual(res.body.counts);
      expect(JSON.stringify(byPhone.body)).not.toContain(b.email);
    }
  });

  // Review of 22 November, M3: the file goes to the customer, so it hides workspace secrets like every other history reader.
  it("hides the workspace's secret values that a step saw", async () => {
    const o = await owner();
    const value = `synthetic-${randomBytes(12).toString("hex")}`;
    await o.agent.put("/secrets/shop_api").send({ value }).expect(204);
    const a = who("Dina Ramos", "dina@secret.test", "0917 222 3333", "+639172223333");
    await seed(o.userId, a);
    const [run] = await db.select({ id: runs.id }).from(runs).where(sql`${runs.triggerPayload}->>'name' = ${a.name}`);
    await db.insert(stepRuns).values({ runId: run!.id, stepId: "post", attempt: 1, state: "failed", input: { url: `https://shop.test/?k=${value}` }, error: `shop answered 401 for ${value}` });
    const res = await exportOf(o.agent, "email=dina@secret.test").expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(value);
    expect(text).toContain("[secret]");
    expect(text).toContain("Dear Dina Ramos");
    expect(res.body.uploads[0].dataBase64).toBe(PNG.toString("base64"));
  });

  it("writes an audit row with counts and no customer value", async () => {
    const o = await owner();
    const a = who("Cara Dizon", "cara@audit.test", "0919 000 1111", "+639190001111");
    await seed(o.userId, a);
    await exportOf(o.agent, "email=cara@audit.test").expect(200);
    const rows = await db.select().from(privacyRequests).where(eq(privacyRequests.userId, o.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "export", actorId: o.userId });
    expect(rows[0]!.counts).toMatchObject({ runs: 1 });
    expect(JSON.stringify(rows)).not.toMatch(/cara|0919|9190001111/i);
  });
});

describe("delete", () => {
  it("removes the customer everywhere, keeps bookkeeping and leaves another customer alone", async () => {
    const o = await owner();
    const a = who("Dina Ocampo", "dina.ocampo@delete.test", "0920 222 3333", "+639202223333");
    const b = who("Eli Santos", "eli.santos@delete.test", "0921 333 4444", "+639213334444");
    const sa = await seed(o.userId, a);
    const sb = await seed(o.userId, b);
    const before = (await exportOf(o.agent, "email=eli.santos@delete.test").expect(200)).body.counts;

    const res = await del(o.agent, { phone: "0920 222 3333", confirm: "DELETE" }).expect(200);
    expect(res.body.counts).toMatchObject({ runs: 1, uploads: 1, deliveries: 1, calendarEvents: 1, dues: 2, claims: 2 });
    expect(res.body.kept.map((k: { item: string }) => k.item)).toEqual(expect.arrayContaining(["payment_dues", "payment_history", "payment_claims", "runs"]));
    expect(res.body.kept.every((k: { reason: string }) => k.reason.length > 0)).toBe(true);

    // A appears nowhere. Every value below is unique to this test, so whole-table dumps are safe.
    const text = await dump();
    for (const s of [a.name, a.email, a.email.toUpperCase(), "0920 222 3333", "+639202223333", "9202223333", `OPEN${a.ref}`]) expect(text).not.toContain(s);
    expect(await db.select().from(uploads).where(eq(uploads.runId, sa.runId))).toHaveLength(0);
    expect(await db.select().from(deliveries).where(eq(deliveries.runId, sa.runId))).toHaveLength(0);
    expect(await db.select().from(calendarEvents).where(eq(calendarEvents.bookingId, sa.booking))).toHaveLength(0);
    const steps = await db.select().from(stepRuns).where(eq(stepRuns.runId, sa.runId));
    expect(steps[0]).toMatchObject({ input: null, output: null, error: null, inputTokens: 12 });
    const [run] = await db.select().from(runs).where(eq(runs.id, sa.runId));
    expect(run).toMatchObject({ state: "cancelled", triggerPayload: { erased: true }, error: null });
    expect((await db.select().from(requests).where(eq(requests.runId, sa.runId)))[0]).toMatchObject({ subject: "Deleted on request", reference: a.ref });
    expect(await db.select().from(bookings).where(eq(bookings.id, sa.booking))).toHaveLength(1);
    const dues = await db.select().from(paymentDues).where(eq(paymentDues.runId, sa.runId));
    expect(dues.map((d) => [d.reference, d.status, d.amountCentavos, d.replyTo, d.replyText]).sort()).toEqual([[`D-${a.ref}`, "pending", 35000, null, null], [`E-${a.ref}`, "confirmed", 10000, null, null]]);
    const mine = (await db.select().from(paymentClaims).where(eq(paymentClaims.userId, o.userId))).filter((c) => sa.dues.includes(c.dueId));
    expect(mine.every((c) => c.image === null && c.imageType === null && c.imageSize === null)).toBe(true);
    expect(mine.find((c) => c.status === "confirmed")!.transferRef).toBe(`CONF${a.ref}`);
    expect(mine.find((c) => c.status !== "confirmed")!.transferRef).toBeNull();
    expect((await db.select().from(paymentHistory).where(eq(paymentHistory.dueId, sa.dues[1]!))).length).toBeGreaterThan(0);
    expect((await db.select().from(paymongoEvents).where(eq(paymongoEvents.eventId, `evt_${a.ref}`)))[0]!.payload).toBeNull();
    expect(await db.select().from(receiptReferences).where(eq(receiptReferences.firstRunId, sa.runId))).toHaveLength(1);

    // B is untouched.
    expect((await exportOf(o.agent, "email=eli.santos@delete.test").expect(200)).body.counts).toEqual(before);
    expect((await db.select().from(runs).where(eq(runs.id, sb.runId)))[0]!.state).toBe("waiting");
    expect(JSON.stringify(await db.select().from(stepRuns).where(eq(stepRuns.runId, sb.runId)))).toContain(b.name);

    // The audit row holds counts and reasons only.
    const audit = (await db.select().from(privacyRequests).where(eq(privacyRequests.action, "delete"))).filter((r) => r.userId === o.userId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.counts).toMatchObject({ runs: 1, dues: 2 });
    expect((audit[0]!.kept as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toMatch(/dina|ocampo|9202223333|0920/i);
  });

  it("finds a customer through a due's reply number alone", async () => {
    const o = await owner();
    const a = who("Fe Lim", "fe.lim@byreply.test", "0922 555 6666", "+639225556666");
    const sa = await seed(o.userId, a);
    await db.update(runs).set({ triggerPayload: { note: "no contact here" } }).where(eq(runs.id, sa.runId));
    expect((await exportOf(o.agent, "email=fe.lim@byreply.test")).body.counts.runs).toBe(0);
    expect((await exportOf(o.agent, "phone=09225556666")).body.counts.runs).toBe(1);
    await del(o.agent, { phone: "09225556666", confirm: "DELETE" }).expect(200);
    expect((await db.select().from(paymentDues).where(eq(paymentDues.runId, sa.runId))).every((d) => d.replyTo === null)).toBe(true);
  });
});

describe("email matching", () => {
  it("leaves a customer whose address contains the deleted one untouched", async () => {
    const o = await owner();
    const a = who("Maria Lopez", "maria@gmail.com", "0924 111 0000", "+639241110000");
    const b = who("Anna Maria", "annamaria@gmail.com", "0925 111 0000", "+639251110000");
    await seed(o.userId, a);
    const sb = await seed(o.userId, b);
    await del(o.agent, { email: "maria@gmail.com", confirm: "DELETE" }).expect(200);
    expect((await db.select().from(runs).where(eq(runs.id, sb.runId)))[0]!.triggerPayload).toMatchObject({ name: "Anna Maria" });
  });
});

describe("workspace isolation", () => {
  it("never exports or deletes another workspace's customer with the same email", async () => {
    const one = await owner();
    const two = await owner();
    const a = who("Gus Tan", "gus.tan@shared.test", "0923 777 8888", "+639237778888");
    await seed(one.userId, a);
    const other = await seed(two.userId, { ...a, ref: `${a.ref}X` });
    const res = await exportOf(one.agent, "email=gus.tan@shared.test").expect(200);
    expect(res.body.runs.map((r: { id: string }) => r.id)).not.toContain(other.runId);
    await del(one.agent, { email: "gus.tan@shared.test", confirm: "DELETE" }).expect(200);
    expect((await db.select().from(runs).where(eq(runs.id, other.runId)))[0]!.triggerPayload).toMatchObject({ name: "Gus Tan" });
    expect((await exportOf(two.agent, "email=gus.tan@shared.test").expect(200)).body.counts.runs).toBe(1);
    expect(await db.select().from(uploads).where(eq(uploads.runId, other.runId))).toHaveLength(1);
  });
});

describe("roles and input", () => {
  it("is for the owner alone: other roles get 403, signed out gets 401", async () => {
    const o = await owner();
    for (const role of ["operator", "approver", "requester"] as const) {
      const m = await member(o.userId, role);
      await exportOf(m, "email=a@b.test").expect(403);
      await del(m, { email: "a@b.test", confirm: "DELETE" }).expect(403);
    }
    await request(server).get("/privacy/customer?email=a@b.test").expect(401);
    await request(server).post("/privacy/customer/delete").send({ email: "a@b.test", confirm: "DELETE" }).expect(401);
  });

  it("refuses a wrong confirmation, both or neither identifier, and malformed values", async () => {
    const o = await owner();
    await del(o.agent, { email: "a@b.test" }).expect(400);
    await del(o.agent, { email: "a@b.test", confirm: "delete" }).expect(400);
    await del(o.agent, { email: "a@b.test", phone: "09171234567", confirm: "DELETE" }).expect(400);
    await del(o.agent, { confirm: "DELETE" }).expect(400);
    await del(o.agent, { email: "not an email", confirm: "DELETE" }).expect(400);
    await del(o.agent, { phone: "12345", confirm: "DELETE" }).expect(400);
    await exportOf(o.agent, "").expect(400);
    await exportOf(o.agent, "email=a@b.test&phone=09171234567").expect(400);
    expect(await db.select().from(privacyRequests).where(eq(privacyRequests.userId, o.userId))).toHaveLength(0);
  });
});

describe("notice on public pages", () => {
  const fields = [{ name: "summary", type: "text" as const, label: "What do you need", required: true }];
  it("names the business, escaped, in English and Tagalog, and falls back without a name", () => {
    expect(renderForm(fields, [], undefined, "Lia & <Co>", "en")).toContain("Lia &amp; &lt;Co&gt; receives what you send here and uses it to answer your request. You can ask Lia &amp; &lt;Co&gt; to show you or delete your details.");
    expect(renderForm(fields, [], undefined, undefined, "en")).toContain("This business receives what you send here and uses it to answer your request. You can ask the business to show you or delete your details.");
    const tl = renderForm(fields, [], undefined, "Lia & <Co>", "tl");
    expect(tl).toContain("Natatanggap ng Lia &amp; &lt;Co&gt; ang ipinapadala mo rito");
    expect(tl).not.toContain("Lia & <Co>");
  });

  it("shows it on the pay page with the profile's business name, in the workspace's language", async () => {
    const o = await owner();
    await db.execute(sql`insert into business_profiles (user_id, business_name) values (${o.userId}, ${"Mila's <Salon>"})`);
    const [wf] = await db.insert(workflows).values({ userId: o.userId, name: "Pay", slug: `p-${++seq}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id }).returning();
    const d = await createDue(db, { userId: o.userId, test: false, workflowId: wf!.id, runId: r!.id, stepId: "ask", reference: `P-${++seq}`, kind: "deposit", amountCentavos: 10000 });
    const en = await request(server).get(`/pay/${d.token}`).expect(200);
    expect(en.text).toContain("Mila&#39;s &lt;Salon&gt; receives what you send here");
    await db.update(users).set({ language: "tl" }).where(eq(users.id, o.userId));
    const tl = await request(server).get(`/pay/${d.token}`).expect(200);
    expect(tl.text).toContain("Natatanggap ng Mila&#39;s &lt;Salon&gt; ang ipinapadala mo rito");
  });
});
