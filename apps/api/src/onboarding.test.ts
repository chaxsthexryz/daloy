import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { onboardingProgress, runs, workflowVersions, workflows } from "@daloy/db";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

let app: INestApplication;
let boss: PgBoss;
let pool: Pool;
let db: Awaited<ReturnType<typeof freshDatabase>>["db"];
let server: Parameters<typeof request>[0];

beforeAll(async () => {
  const fresh = await freshDatabase();
  pool = fresh.pool;
  db = fresh.db;
  boss = new PgBoss(fresh.url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

let seq = 0;
async function newOwner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `onb${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return { agent, id: res.body.id as string };
}
type Owner = Awaited<ReturnType<typeof newOwner>>;

const identity = { businessName: "Ana's Sweets", website: "https://anassweets.example" };
const type = { primary: "food_orders", related: ["online_retail"] };
async function throughScreen3(o: Owner, workflow: object = { goal: "order_follow_up", payment: "pay_later" }) {
  await o.agent.put("/onboarding/identity").send(identity).expect(200);
  await o.agent.put("/onboarding/type").send(type).expect(200);
  await o.agent.put("/onboarding/workflow").send(workflow).expect(200);
}

describe("onboarding progress", () => {
  it("starts a new owner at screen 1 with nothing saved", async () => {
    const o = await newOwner();
    const s = (await o.agent.get("/onboarding").expect(200)).body;
    expect(s).toMatchObject({ status: "not_started", completed: 0, step: 1, identity: { businessName: null, website: null, logoUrl: null }, primary: null, related: [], goal: null, payment: null, workflowId: null });
  });

  it("saves after each screen and resumes at the first screen not saved", async () => {
    const o = await newOwner();
    await o.agent.put("/onboarding/identity").send(identity).expect(200);
    expect((await o.agent.get("/onboarding").expect(200)).body).toMatchObject({ status: "in_progress", completed: 1, step: 2, identity });
    await o.agent.put("/onboarding/type").send(type).expect(200);
    expect((await o.agent.get("/onboarding").expect(200)).body).toMatchObject({ completed: 2, step: 3, primary: "food_orders", related: ["online_retail"], suggestedGoal: "order_follow_up" });
    await o.agent.put("/onboarding/workflow").send({ goal: "receipt_review", payment: "manual_qrph" }).expect(200);
    expect((await o.agent.get("/onboarding").expect(200)).body).toMatchObject({ completed: 3, step: 3, goal: "receipt_review", payment: "manual_qrph" });
  });

  it("lets an owner go back and change an earlier answer without losing the later ones", async () => {
    const o = await newOwner();
    await throughScreen3(o);
    await o.agent.put("/onboarding/identity").send({ businessName: "Ana's Sweet Shop", website: "" }).expect(200);
    const s = (await o.agent.get("/onboarding").expect(200)).body;
    expect(s).toMatchObject({ completed: 3, identity: { businessName: "Ana's Sweet Shop", website: null }, primary: "food_orders", goal: "order_follow_up", payment: "pay_later" });
  });

  it("refuses a screen before the one in front of it is saved", async () => {
    const o = await newOwner();
    await o.agent.put("/onboarding/type").send(type).expect(409);
    await o.agent.put("/onboarding/workflow").send({ goal: "bookings" }).expect(409);
    await o.agent.post("/onboarding/finish").expect(409);
    await o.agent.put("/onboarding/identity").send(identity).expect(200);
    await o.agent.put("/onboarding/workflow").send({ goal: "bookings" }).expect(409);
    await o.agent.post("/onboarding/finish").expect(409);
  });

  it("validates every screen at the boundary", async () => {
    const o = await newOwner();
    await o.agent.put("/onboarding/identity").send({ businessName: "   ", website: "" }).expect(400);
    await o.agent.put("/onboarding/identity").send({ businessName: "A", website: "javascript:alert(1)" }).expect(400);
    await o.agent.put("/onboarding/identity").send({ ...identity, extra: 1 }).expect(400);
    await o.agent.put("/onboarding/identity").send(identity).expect(200);
    await o.agent.put("/onboarding/type").send({ primary: "food_orders", related: ["food_orders"] }).expect(400);
    await o.agent.put("/onboarding/type").send({ primary: "other", related: ["online_retail", "food_orders", "beauty_wellness", "professional_services"] }).expect(400);
    await o.agent.put("/onboarding/type").send(type).expect(200);
    await o.agent.put("/onboarding/type").send({ primary: "resorts_hotels", related: ["food_orders"] }).expect(200);
    expect((await o.agent.get("/onboarding").expect(200)).body).toMatchObject({ primary: "resorts_hotels", related: ["food_orders"], suggestedGoal: "bookings" });
    await o.agent.put("/onboarding/type").send(type).expect(200);
    await o.agent.put("/onboarding/workflow").send({ goal: "receipt_review" }).expect(400);
    await o.agent.put("/onboarding/workflow").send({ goal: "order_follow_up", payment: "card" }).expect(400);
  });

  it("keeps the other business details and the brand when the name changes", async () => {
    const o = await newOwner();
    await o.agent.put("/settings/email/profile").send({ businessName: "Old name", website: "", inquiryEmail: "front@anas.example", replyTo: "" }).expect(204);
    await o.agent.put("/settings/brand").send({ accent: "#0a84ff" }).expect(200);
    expect((await o.agent.get("/onboarding").expect(200)).body.identity.businessName).toBe("Old name");
    await o.agent.put("/onboarding/identity").send(identity).expect(200);
    const profile = (await o.agent.get("/settings/email").expect(200)).body.profile;
    expect(profile).toMatchObject({ businessName: "Ana's Sweets", inquiryEmail: "front@anas.example" });
    expect((await o.agent.get("/settings/brand").expect(200)).body.accent).toBe("#0a84ff");
  });

  it("shows the logo the owner uploaded with the brand kit", async () => {
    const o = await newOwner();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
    await o.agent.put("/settings/brand/logo").send({ data: png.toString("base64") }).expect(200);
    expect((await o.agent.get("/onboarding").expect(200)).body.identity.logoUrl).toBe(`/brand/logo/${o.id}`);
  });

  it("needs an owner", async () => {
    await request(server).get("/onboarding").expect(401);
    await request(server).post("/onboarding/finish").expect(401);
  });
});

describe("onboarding first draft", () => {
  it("makes one unpublished draft from the closest template, with a sample order and the owner as reviewer", async () => {
    const o = await newOwner();
    await throughScreen3(o);
    const res = (await o.agent.post("/onboarding/finish").expect(201)).body;
    expect(res.created).toBe(true);
    const [wf] = await db.select().from(workflows).where(eq(workflows.id, res.workflowId));
    expect(wf!.userId).toBe(o.id);
    const versions = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, res.workflowId));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.published).toBe(false);
    expect(JSON.stringify(versions[0]!.definition)).not.toContain("owner@example.com");
    const s = (await o.agent.get("/onboarding").expect(200)).body;
    expect(s).toMatchObject({ status: "completed", workflowId: res.workflowId, template: { slug: "store-orders", stopgap: true } });
    expect(s.sample).toEqual({ order_id: "SAMPLE-1001", customer_name: "Ana Reyes", customer_email: "ana@example.com", total: 850 });
  });

  it("picks a booking template for bookings, and the checkout template for GCash checkout", async () => {
    const a = await newOwner();
    await throughScreen3(a, { goal: "bookings", payment: "manual_qrph" });
    await a.agent.post("/onboarding/finish").expect(201);
    expect((await a.agent.get("/onboarding").expect(200)).body).toMatchObject({ template: { slug: "lead-to-booking" }, payment: null });
    const b = await newOwner();
    await throughScreen3(b, { goal: "order_follow_up", payment: "gcash_paymongo" });
    await b.agent.post("/onboarding/finish").expect(201);
    expect((await b.agent.get("/onboarding").expect(200)).body.template.slug).toBe("order-gcash-checkout");
  });

  it("opens the same draft when onboarding runs twice, one after the other or at the same moment", async () => {
    const o = await newOwner();
    await throughScreen3(o);
    const [a, b, c] = await Promise.all([o.agent.post("/onboarding/finish"), o.agent.post("/onboarding/finish"), o.agent.post("/onboarding/finish")]);
    const ids = new Set([a, b, c].map((r) => r.body.workflowId as string));
    expect(ids.size).toBe(1);
    expect([a, b, c].filter((r) => r.body.created)).toHaveLength(1);
    const again = (await o.agent.post("/onboarding/finish").expect(201)).body;
    expect(again).toEqual({ workflowId: [...ids][0], created: false });
    expect(await db.select().from(workflows).where(eq(workflows.userId, o.id))).toHaveLength(1);
  });

  it("keeps the draft when the answers are edited afterwards", async () => {
    const o = await newOwner();
    await throughScreen3(o);
    const first = (await o.agent.post("/onboarding/finish").expect(201)).body.workflowId as string;
    await o.agent.put("/onboarding/workflow").send({ goal: "bookings" }).expect(200);
    expect((await o.agent.post("/onboarding/finish").expect(201)).body).toEqual({ workflowId: first, created: false });
    expect((await o.agent.get("/onboarding").expect(200)).body.workflowId).toBe(first);
  });

  it("makes a new draft only when the owner deleted the first one", async () => {
    const o = await newOwner();
    await throughScreen3(o);
    const first = (await o.agent.post("/onboarding/finish").expect(201)).body.workflowId as string;
    await db.delete(workflows).where(eq(workflows.id, first));
    const second = (await o.agent.post("/onboarding/finish").expect(201)).body;
    expect(second.created).toBe(true);
    expect(second.workflowId).not.toBe(first);
  });

  it("does not take a slug the owner already uses", async () => {
    const o = await newOwner();
    await o.agent.post("/workflows").send({ name: "Mine", slug: "first-workflow" }).expect(201);
    await throughScreen3(o);
    await o.agent.post("/onboarding/finish").expect(201);
    expect(await db.select().from(workflows).where(eq(workflows.userId, o.id))).toHaveLength(2);
  });

  it("starts nothing: no connection, no run, no published version", async () => {
    const o = await newOwner();
    await throughScreen3(o);
    const id = (await o.agent.post("/onboarding/finish").expect(201)).body.workflowId as string;
    const wf = (await o.agent.get(`/workflows/${id}`).expect(200)).body;
    expect(wf.live).toBeNull();
    expect(await db.select().from(runs).innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId)).where(eq(workflowVersions.workflowId, id))).toHaveLength(0);
  });
});

describe("onboarding for owners who already existed", () => {
  it("shows a dismissed workspace as dismissed, and lets the owner start onboarding from there", async () => {
    const o = await newOwner();
    await db.insert(onboardingProgress).values({ userId: o.id, status: "dismissed" });
    expect((await o.agent.get("/onboarding").expect(200)).body).toMatchObject({ status: "dismissed", completed: 0, step: 1 });
    await o.agent.put("/onboarding/identity").send(identity).expect(200);
    expect((await o.agent.get("/onboarding").expect(200)).body.status).toBe("in_progress");
  });

  it("dismisses a new owner's prompt without touching their answers", async () => {
    const o = await newOwner();
    await o.agent.put("/onboarding/identity").send(identity).expect(200);
    await o.agent.post("/onboarding/dismiss").expect(204);
    expect((await o.agent.get("/onboarding").expect(200)).body).toMatchObject({ status: "dismissed", completed: 1, identity });
  });
});
