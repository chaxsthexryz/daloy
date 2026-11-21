import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { workflows, type Db } from "@daloy/db";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

// E7 and E8: what a visitor sees on the public form, the receipt, the paused page and the embed (decision 0079).
let app: INestApplication;
let boss: PgBoss;
let pool: Pool;
let db: Db;
let server: Parameters<typeof request>[0];

beforeAll(async () => {
  const fresh = await freshDatabase();
  pool = fresh.pool;
  db = fresh.db;
  boss = new PgBoss(fresh.url);
  await boss.start();
  app = await createApp({ db: fresh.db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

const HTML = "text/html,application/xhtml+xml,*/*;q=0.8";
let seq = 0;
async function owner(fields: unknown[], tracked = false) {
  const agent = request.agent(server);
  const reg = await agent.post("/auth/register").send({ email: `pub${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  const wf = await agent.post("/workflows").send({ name: "Requests", slug: `req-${seq}` }).expect(201);
  const definition = { trigger: { type: "form", config: { fields } }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
  if (tracked) await db.update(workflows).set({ setup: { template: "office-request" } }).where(eq(workflows.id, wf.body.id));
  const formId = (await agent.get(`/workflows/${wf.body.id}`).expect(200)).body.trigger.id as string;
  return { agent, formId, workflowId: wf.body.id as string, id: reg.body.id as string };
}

const fields = [
  { name: "summary", label: "What do you need?", type: "text", required: true },
  { name: "amount", label: "Amount in pesos", type: "number", required: true, min: 1 },
  { name: "email", label: "Your email", type: "email", required: false },
];

describe("public form validation page", () => {
  it("gives a browser the form back with each reason beside its field and the answers kept", async () => {
    const o = await owner(fields);
    const res = await request(server).post(`/forms/${o.formId}`).set("Accept", HTML).type("form").send({ summary: "Two <tables>", amount: "0", email: "a@b.ph" }).expect(400);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain('role="alert"');
    expect(res.text).toContain("The form was not sent");
    expect(res.text).toContain('id="e-amount"');
    expect(res.text).toContain("must be at least 1");
    expect(res.text).toContain('value="Two &lt;tables&gt;"');
    expect(res.text).toContain('value="a@b.ph"');
    expect(res.text).not.toContain("Two <tables>");
  });

  it("keeps the JSON error for an API caller", async () => {
    const o = await owner(fields);
    const res = await request(server).post(`/forms/${o.formId}`).type("form").send({ summary: "x", amount: "0" }).expect(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.stringify(res.body)).toContain("amount: must be at least 1");
  });

  it("shows a file that is not a photo or PDF as a field error", async () => {
    const o = await owner([{ name: "summary", label: "What do you need?", type: "text", required: true }, { name: "quote", label: "Quote", type: "file", required: false }]);
    const res = await request(server).post(`/forms/${o.formId}`).set("Accept", HTML).field("summary", "Tables").attach("quote", Buffer.from("not a pdf"), { filename: "menu.docx" }).expect(400);
    expect(res.text).toContain("must be a JPEG, PNG, WebP or HEIC photo, or a PDF");
    expect(res.text).toContain('value="Tables"');
  });
});

describe("receipt, duplicates and the paused page", () => {
  it("shows the reference in the receipt card and answers a repeated send with the same reference", async () => {
    const o = await owner(fields, true);
    const page = await request(server).get(`/forms/${o.formId}`).expect(200);
    const key = /name="submission_key" value="([^"]+)"/.exec(page.text)![1]!;
    const send = () => request(server).post(`/forms/${o.formId}`).set("Accept", HTML).type("form").send({ summary: "Tables", amount: "1800", submission_key: key });
    const first = await send().expect(200);
    const reference = /REQ-[0-9A-Z]{6}/.exec(first.text)![0];
    expect(first.text).toContain('class="receipt"');
    expect(first.text).toContain("Your reference is");
    expect(first.text).toContain(">Received<");
    expect((await send().expect(200)).text).toContain(reference);
  });

  it("says a paused form is paused, with a status pill, on the page and after a post", async () => {
    const o = await owner(fields);
    await o.agent.post(`/workflows/${o.workflowId}/pause`).send({}).expect((r) => expect(r.status).toBeLessThan(300));
    const page = await request(server).get(`/forms/${o.formId}`).expect(200);
    expect(page.text).toContain("This form is paused");
    expect(page.text).toContain("Not taking submissions");
    const post = await request(server).post(`/forms/${o.formId}`).type("form").send({ summary: "x", amount: "5" }).expect(409);
    expect(post.text).toContain("This form is paused");
  });
});

describe("embedded form", () => {
  it("drops the page background and allows framing, and a refused send stays inside the frame", async () => {
    const o = await owner(fields);
    const page = await request(server).get(`/forms/${o.formId}/embed`).expect(200);
    expect(page.text).toContain('<body class="embed">');
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors");
    expect(page.headers["x-frame-options"]).toBeUndefined();
    const plain = await request(server).get(`/forms/${o.formId}`).expect(200);
    expect(plain.text).not.toContain('class="embed"');
    expect(plain.headers["x-frame-options"]).toBeDefined();
    const bad = await request(server).post(`/forms/${o.formId}/embed`).set("Accept", HTML).type("form").send({ summary: "x", amount: "0" }).expect(400);
    expect(bad.text).toContain('<body class="embed">');
  });
});

// E9 (decision 0080): open times for a booking form, and the page a visitor gets when the time was taken meanwhile.
describe("booking form", () => {
  const year = new Date().getUTCFullYear() + 1;
  const bookingFields = [
    { name: "email", label: "Your email", type: "email", required: true },
    { name: "room", label: "Resource", type: "resource", required: true },
    { name: "at", label: "Date and time", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
  ];
  async function bookable() {
    const o = await owner(bookingFields);
    const room = (await o.agent.post("/resources").send({ name: "Tasting room" }).expect(201)).body.id as string;
    // 10:00 to 11:00 in Manila on 20 January is 02:00 to 03:00 UTC.
    await db.execute(sql`insert into bookings (user_id, test, reference, resource_id, during, timezone) values (${o.id}, false, 'BK-E9TEST', ${room}, tstzrange(${`${year}-01-20T02:00:00Z`}::timestamptz, ${`${year}-01-20T03:00:00Z`}::timestamptz, '[)'), 'Asia/Manila')`);
    return { ...o, room };
  }

  it("adds the open times area and its script only to a form with a resource and a slot grid", async () => {
    const o = await bookable();
    const page = await request(server).get(`/forms/${o.formId}`).expect(200);
    expect(page.text).toContain("data-slots");
    expect(page.text).toContain('src="/public/slots.js"');
    const plain = await owner(fields);
    expect((await request(server).get(`/forms/${plain.formId}`).expect(200)).text).not.toContain("data-slots");
    const script = await request(server).get("/public/slots.js").expect(200);
    expect(script.headers["content-type"]).toContain("javascript");
    expect(script.text).toContain("data-slots");
  });

  it("lists the day's slots with the booked one taken, and nothing about who booked it", async () => {
    const o = await bookable();
    const res = await request(server).get(`/forms/${o.formId}/slots`).query({ resource: o.room, date: `${year}-01-20`, field: "at" }).expect(200);
    expect(res.body.title).toMatch(/^Open times on /);
    expect(res.body.slots).toHaveLength(8);
    expect(res.body.slots.filter((s: { taken: boolean }) => s.taken).map((s: { label: string }) => s.label)).toEqual(["10:00 am"]);
    expect(JSON.stringify(res.body)).not.toContain("BK-E9TEST");
  });

  it("answers 404 for a resource of another workspace and 400 for a bad date", async () => {
    const o = await bookable();
    const other = await bookable();
    await request(server).get(`/forms/${o.formId}/slots`).query({ resource: other.room, date: `${year}-01-20` }).expect(404);
    await request(server).get(`/forms/${o.formId}/slots`).query({ resource: o.room, date: `${year}-02-30` }).expect(400);
    await request(server).get(`/forms/${o.formId}/slots`).query({ resource: "nope", date: `${year}-01-20` }).expect(400);
  });

  it("gives a browser the form back with the taken notice, and still accepts a free time", async () => {
    const o = await bookable();
    const send = (time: string) => request(server).post(`/forms/${o.formId}`).set("Accept", HTML).type("form").send({ email: "jo@sampaguita.ph", room: o.room, at: `${year}-01-20T${time}` });
    const taken = await send("10:00").expect(409);
    expect(taken.text).toContain("That time is no longer available");
    expect(taken.text).toContain("Tasting room is already booked for");
    expect(taken.text).toContain('value="jo@sampaguita.ph"');
    expect(taken.text).toContain('value="');
    await send("11:00").expect(200);
    // An API caller is not turned away here: the booking step decides and has a taken branch.
    await request(server).post(`/forms/${o.formId}`).type("form").send({ email: "jo@sampaguita.ph", room: o.room, at: `${year}-01-20T10:00` }).expect(200);
  });
});
