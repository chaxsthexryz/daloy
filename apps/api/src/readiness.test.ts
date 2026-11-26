import { randomBytes } from "node:crypto";
import { users, workflowVersions, type Db } from "@daloy/db";
import { TEMPLATES, type ReadinessReport } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { createApp } from "./app";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let fake: FakeProviders;
let seq = 0;
const key = randomBytes(32);

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  fake = await startFakeProviders();
  app = await createApp({ db, boss, secretsKey: key, secureCookies: false, providers: { ...fake.urls, timeoutMs: 2000 } });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await fake?.close();
  await pool?.end();
});

async function owner(opts: { plan?: "preview" | "pilot" | "business" | "concierge" | null } = {}) {
  const email = `ready${++seq}@test.local`;
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email, password: "correct horse battery" }).expect(201);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  if (opts.plan !== undefined) {
    await db.update(users).set({ plan: opts.plan }).where(eq(users.id, u!.id));
  }
  return { agent, userId: u!.id, email };
}

describe("server-side readiness service (G1)", () => {
  it("evaluates every starter template in a fresh workspace and reports accurate blockers", async () => {
    const o = await owner({ plan: "preview" });
    const saved = { UNISMS_SECRET_KEY: process.env.UNISMS_SECRET_KEY, UNISMS_SENDER_ID: process.env.UNISMS_SENDER_ID };
    delete process.env.UNISMS_SECRET_KEY;
    delete process.env.UNISMS_SENDER_ID;
    try {
      const res = await o.agent.get("/templates/readiness").expect(200);
      const list = res.body as (ReadinessReport & { slug: string })[];
      expect(list.map((t) => t.slug)).toEqual(TEMPLATES.map((t) => t.slug));
      const bySlug = new Map(list.map((t) => [t.slug, t]));

      // Templates with no external connections, resources, knowledge, or secrets are ready out of the box.
      expect(bySlug.get("inquiry-triage")?.ready).toBe(true);
      expect(bySlug.get("appointment-reminder")?.ready).toBe(true);
      expect(bySlug.get("no-show-follow-up")?.ready).toBe(true);

      // Lead to booking needs a resource and Google Calendar.
      const lead = bySlug.get("lead-to-booking")!;
      expect(lead.ready).toBe(false);
      expect(lead.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "resource", what: "resources" }),
          expect.objectContaining({ kind: "connect", app: "google_calendar" }),
        ]),
      );

      // Order to sheets needs PayMongo and Google Sheets.
      const order = bySlug.get("order-to-sheets")!;
      expect(order.ready).toBe(false);
      expect(order.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "connect", app: "paymongo" }),
          expect.objectContaining({ kind: "connect", app: "google_sheets" }),
        ]),
      );

      // Resort concierge DM needs Knowledge published and Meta Messenger connected.
      const concierge = bySlug.get("resort-concierge-dm")!;
      expect(concierge.ready).toBe(false);
      expect(concierge.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "knowledge", what: "knowledge" }),
          expect.objectContaining({ kind: "connect", app: "meta_messenger" }),
        ]),
      );

      // Booking deposit review needs a resource and SMS (both server setup and paid plan).
      const deposit = bySlug.get("booking-deposit-review")!;
      expect(deposit.ready).toBe(false);
      expect(deposit.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "resource" }),
          expect.objectContaining({ kind: "operator", what: "sms_unavailable" }),
          expect.objectContaining({ kind: "operator", what: "sms_plan" }),
        ]),
      );

      // Lalamove template needs Lalamove secrets.
      const lalamove = bySlug.get("lalamove-confirmed-order")!;
      expect(lalamove.ready).toBe(false);
      expect(lalamove.blockers).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "connect", app: "lalamove" })]),
      );

      // Invoice PayMongo webhook template needs its signing secret and PayMongo.
      const invoice = bySlug.get("invoice-paymongo")!;
      expect(invoice.ready).toBe(false);
      expect(invoice.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "secret", what: "invoice_webhook_secret" }),
          expect.objectContaining({ kind: "connect", app: "paymongo" }),
        ]),
      );
    } finally {
      if (saved.UNISMS_SECRET_KEY === undefined) delete process.env.UNISMS_SECRET_KEY;
      else process.env.UNISMS_SECRET_KEY = saved.UNISMS_SECRET_KEY;
      if (saved.UNISMS_SENDER_ID === undefined) delete process.env.UNISMS_SENDER_ID;
      else process.env.UNISMS_SENDER_ID = saved.UNISMS_SENDER_ID;
    }
  });

  it("checks workflow readiness and blocks Publish with the exact same blockers", async () => {
    const o = await owner({ plan: null });
    const saved = { UNISMS_SECRET_KEY: process.env.UNISMS_SECRET_KEY, UNISMS_SENDER_ID: process.env.UNISMS_SENDER_ID };
    process.env.UNISMS_SECRET_KEY = "unisms_synth_key"; // gitleaks:allow
    process.env.UNISMS_SENDER_ID = "kymavo";
    try {
      const lalamoveDef = TEMPLATES.find((t) => t.slug === "lalamove-confirmed-order")!.definition;
      const wf = (await o.agent.post("/workflows").send({ name: "Lalamove flow", slug: `lalamove-${seq}` }).expect(201)).body as { id: string };
      await o.agent.post(`/workflows/${wf.id}/versions`).send({ definition: lalamoveDef, publish: false }).expect(201);

      // Both GET /workflows/:id/readiness and POST /workflows/readiness agree Publish must refuse.
      const getReport = (await o.agent.get(`/workflows/${wf.id}/readiness`).expect(200)).body as ReadinessReport;
      const postReport = (await o.agent.post("/workflows/readiness").send({ definition: lalamoveDef, workflowId: wf.id }).expect(200)).body as ReadinessReport;
      expect(getReport.ready).toBe(false);
      expect(postReport.ready).toBe(false);
      expect(getReport.blockers.some((b) => b.kind === "connect" && b.app === "lalamove")).toBe(true);
      expect(getReport.blockers.some((b) => b.kind === "secret" && b.what === "order_webhook_secret")).toBe(true);
      expect(postReport.blockers).toEqual(getReport.blockers);

      await o.agent.post(`/workflows/${wf.id}/versions`).send({ definition: lalamoveDef, publish: true }).expect(400);

      // Save Lalamove keys + webhook signing secret -> readiness flips green and Publish succeeds.
      await o.agent.put("/secrets/lalamove_api_key").send({ value: "pk_test_lalamove" }).expect(204);
      await o.agent.put("/secrets/lalamove_api_secret").send({ value: "sk_test_lalamove" }).expect(204);
      await o.agent.put("/secrets/order_webhook_secret").send({ value: "whsec_test_123" }).expect(204);

      const readyNow = (await o.agent.get(`/workflows/${wf.id}/readiness`).expect(200)).body as ReadinessReport;
      expect(readyNow.ready).toBe(true);
      expect(readyNow.blockers).toEqual([]);
      await o.agent.post(`/workflows/${wf.id}/versions`).send({ definition: lalamoveDef, publish: true }).expect(201);
    } finally {
      if (saved.UNISMS_SECRET_KEY === undefined) delete process.env.UNISMS_SECRET_KEY;
      else process.env.UNISMS_SECRET_KEY = saved.UNISMS_SECRET_KEY;
      if (saved.UNISMS_SENDER_ID === undefined) delete process.env.UNISMS_SENDER_ID;
      else process.env.UNISMS_SENDER_ID = saved.UNISMS_SENDER_ID;
    }
  });

  it("blocks Publish on missing resource or unpublished knowledge and clears once added", async () => {
    const o = await owner({ plan: null });
    const bookingDef = {
      trigger: {
        type: "form",
        config: {
          fields: [
            { name: "email", label: "Email", type: "email", required: true },
            { name: "room", label: "Room", type: "resource", required: true },
            { name: "at", label: "When", type: "datetime", timezone: "Asia/Manila", required: true },
          ],
        },
      },
      steps: [{ id: "book", type: "booking", config: { action: "create", resource: "{{trigger.room}}", start: "{{trigger.at}}", minutes: 60 } }],
      edges: [],
    };
    const wf = (await o.agent.post("/workflows").send({ name: "Room book", slug: `book-${seq}` }).expect(201)).body as { id: string };

    const r1 = (await o.agent.post("/workflows/readiness").send({ definition: bookingDef, workflowId: wf.id }).expect(200)).body as ReadinessReport;
    expect(r1.ready).toBe(false);
    expect(r1.blockers[0]).toMatchObject({ kind: "resource", what: "resources" });
    await o.agent.post(`/workflows/${wf.id}/versions`).send({ definition: bookingDef, publish: true }).expect(400);

    await o.agent.post("/resources").send({ name: "Room 101" }).expect(201);
    const r2 = (await o.agent.post("/workflows/readiness").send({ definition: bookingDef, workflowId: wf.id }).expect(200)).body as ReadinessReport;
    expect(r2.ready).toBe(true);
    await o.agent.post(`/workflows/${wf.id}/versions`).send({ definition: bookingDef, publish: true }).expect(201);

    // Knowledge check
    const knDef = {
      trigger: { type: "manual", config: {} },
      steps: [{ id: "ans", type: "ai", config: { task: "answer", input: "rates?" } }],
      edges: [],
    };
    const wf2 = (await o.agent.post("/workflows").send({ name: "FAQ", slug: `faq-${seq}` }).expect(201)).body as { id: string };
    const k1 = (await o.agent.post("/workflows/readiness").send({ definition: knDef, workflowId: wf2.id }).expect(200)).body as ReadinessReport;
    expect(k1.ready).toBe(false);
    expect(k1.blockers[0]).toMatchObject({ kind: "knowledge", what: "knowledge" });
    await o.agent.post(`/workflows/${wf2.id}/versions`).send({ definition: knDef, publish: true }).expect(400);

    await o.agent.post("/knowledge/entries").send({ kind: "policy", title: "Standard", body: "PHP 2,500", fields: {} }).expect(201);
    await o.agent.post("/knowledge/publish").expect(201);
    const k2 = (await o.agent.post("/workflows/readiness").send({ definition: knDef, workflowId: wf2.id }).expect(200)).body as ReadinessReport;
    expect(k2.ready).toBe(true);
    await o.agent.post(`/workflows/${wf2.id}/versions`).send({ definition: knDef, publish: true }).expect(201);
  });

  it("returns 404 for another workspace's workflow readiness", async () => {
    const a = await owner();
    const b = await owner();
    const wf = (await a.agent.post("/workflows").send({ name: "Private", slug: `priv-${seq}` }).expect(201)).body as { id: string };
    await db.insert(workflowVersions).values({
      workflowId: wf.id,
      version: 1,
      definition: { trigger: { type: "manual", config: {} }, steps: [{ id: "w", type: "delay", config: { seconds: 1 } }], edges: [] },
    });
    await b.agent.get(`/workflows/${wf.id}/readiness`).expect(404);
  });
});
