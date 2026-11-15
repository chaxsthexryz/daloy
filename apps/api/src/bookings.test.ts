import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { bookings, joinWorkspace, runs, sessions, stepRuns, users, type Db, type MailDeps } from "@daloy/db";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import { asc, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { advance, type StepExecutor } from "../../worker/src/advance";
import { createExecutor } from "../../worker/src/steps";
import { createApp } from "./app";
import { sha256 } from "./http";

// P6b: staff, MCP and runs around one booking (decision 0032). Runs advance with the real executor; mail is recorded.
vi.setConfig({ testTimeout: 30_000 });

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let base: string;
const key = randomBytes(32);
const mailSent: { to: string; subject: string; text: string }[] = [];
const mail: MailDeps = {
  installation: {
    from: "Daloy <daloy@localhost>",
    transport: {
      sendMail: async (msg: { to?: string; subject?: string; text?: string }) => {
        mailSent.push({ to: String(msg.to), subject: String(msg.subject), text: String(msg.text) });
        return {};
      },
    } as unknown as MailDeps["installation"]["transport"],
  },
  gmail: () => {
    throw new Error("no Gmail here");
  },
  sharedMail: "open",
};

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: key, secureCookies: false, mail });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

type Agent = ReturnType<typeof request.agent>;
const PASSWORD = "correct horse battery";
let seq = 0;
const deps = () => ({ db, executor: createExecutor({ db, secretsKey: key, mail, publicUrl: "https://daloy.example.com" }), owner: "bookings-test", leaseMs: 5000, retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, enqueue: async () => {} });
const runRow = async (id: string) => (await db.select().from(runs).where(eq(runs.id, id)))[0]!;
/** Advances a run until it finishes or parks on a wait (the reminder is a day before a far-off appointment). */
async function drive(runId: string) {
  for (let i = 0; i < 50; i++) {
    const run = await runRow(runId);
    if (["succeeded", "failed", "cancelled", "needs_review"].includes(run.state)) return run;
    if (run.state === "waiting" && run.nextAttemptAt && run.nextAttemptAt > new Date()) return run;
    await advance(deps(), runId);
  }
  throw new Error(`run ${runId} did not settle`);
}
/** Wakes a waiting run now, as its wake-up time would. */
async function wake(runId: string) {
  await db.update(runs).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(runs.id, runId));
  return drive(runId);
}
const pathOf = async (runId: string) => (await db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(asc(stepRuns.createdAt))).map((r) => `${r.stepId}:${r.state}`);
/** Returns once n sessions of this database wait for a lock (pg-boss's own queries aside). */
async function lockWaiters(n: number) {
  for (;;) {
    const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query not ilike '%pgboss%'");
    if (rows[0]!.n >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}
/** An executor that stops at the start of each attempt until the test lets it go. */
function gated() {
  const real = deps().executor;
  let go!: () => void;
  let arrived!: () => void;
  const open = new Promise<void>((r) => (go = r));
  const here = new Promise<void>((r) => (arrived = r));
  const executor: StepExecutor = {
    execute: async (input) => {
      arrived();
      await open;
      return real.execute(input);
    },
  };
  return { go, here, executor };
}

async function owner() {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post("/auth/register").send({ email: `bk${++seq}@test.local`, password: PASSWORD }).expect(201);
  return { agent, id: res.body.id as string };
}
async function member(ownerAgent: Agent, role: "operator" | "approver" | "requester") {
  const workspaceId = (await ownerAgent.get("/auth/me").expect(200)).body.workspaceId as string;
  const [u] = await db.insert(users).values({ email: `bk${++seq}@test.local`, passwordHash: await hash(PASSWORD) }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(app.getHttpServer()).set("Cookie", `daloy_session=${token}`);
}

const year = new Date().getUTCFullYear() + 1;
const at = (time: string, day = 20) => `${year}-01-${day}T${time}`;
const fields = [
  { name: "email", label: "Email", type: "email", required: true },
  { name: "who", label: "Therapist", type: "resource", required: true },
  { name: "at", label: "Appointment", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
];
const email = (id: string, subject: string, text: string) => ({ id, type: "email", config: { to: "{{trigger.email}}", subject, text } });
const spa = (before: object[] = [], extraEdges: object[] = []) => ({
  trigger: { type: "webhook", config: { fields } },
  steps: [
    ...before,
    { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.who}}", start: "{{trigger.at}}", minutes: 60 } },
    email("confirm", "Booked {{steps.book.output.reference}}", "{{steps.book.output.start}} with {{steps.book.output.resource.name}}"),
    { id: "wait", type: "delay", config: { until: "{{steps.book.output.start}}", offsetSeconds: -86_400 } },
    email("remind", "Reminder {{steps.book.output.reference}}", "See you at {{steps.book.output.start}}"),
    email("sorry", "That time is taken", "Please pick another time."),
  ],
  edges: [{ from: "book", to: "confirm", on: "done" }, { from: "book", to: "sorry", on: "taken" }, { from: "confirm", to: "wait" }, { from: "wait", to: "remind" }, ...extraEdges],
});

async function setup(definition: object = spa()) {
  const o = await owner();
  const ana = (await o.agent.post("/resources").send({ name: "Ana" }).expect(201)).body as { id: string };
  const wf = (await o.agent.post("/workflows").send({ name: "Spa", slug: `spa-${++seq}` }).expect(201)).body as { id: string };
  await o.agent.post(`/workflows/${wf.id}/versions`).send({ definition, publish: true }).expect(201);
  const book = async (time = at("14:00"), agent: Agent = o.agent) => {
    const res = await agent.post(`/workflows/${wf.id}/runs`).send({ payload: { email: "mia@example.com", who: ana.id, at: time } }).expect(202);
    return { runId: res.body.id as string, run: await drive(res.body.id as string) };
  };
  const listed = async () => (await o.agent.get("/bookings").expect(200)).body as { id: string; reference: string; status: string; version: number; start: string; attention: boolean; runId: string }[];
  return { ...o, ana, wf, book, listed };
}

describe("booking a therapist", () => {
  it("books once, and the second request for that time takes the taken branch", async () => {
    const s = await setup();
    const first = await s.book();
    expect(first.run.state).toBe("waiting");
    expect(await pathOf(first.runId)).toEqual(["book:succeeded", "confirm:succeeded", "wait:waiting"]);
    const second = await s.book(at("14:00"));
    expect(second.run.state).toBe("succeeded");
    expect(await pathOf(second.runId)).toEqual(["book:succeeded", "sorry:succeeded"]);
    const [b] = await s.listed();
    expect(b).toMatchObject({ status: "active", version: 1, start: `${at("14:00")}:00+08:00`, attention: false });
    expect(b!.reference).toMatch(/^BK-/);
  });

  it("keeps builder test bookings apart: they never collide with live ones and staff never see them", async () => {
    const s = await setup();
    await s.book();
    const test = await s.agent.post(`/workflows/${s.wf.id}/test-runs`).send({ definition: spa(), payload: { email: "mia@example.com", who: s.ana.id, at: at("14:00") } }).expect(202);
    await drive(test.body.id);
    expect(await pathOf(test.body.id)).toEqual(["book:succeeded", "confirm:succeeded", "wait:waiting"]);
    expect(String(((await db.select().from(stepRuns).where(eq(stepRuns.runId, test.body.id)))[0]!.output as { reference: string }).reference)).toMatch(/^TEST-/);
    expect(await s.listed()).toHaveLength(1);
  });

  it("flags a booking whose run failed after booking it, and keeps it active", async () => {
    const failing = spa([], []);
    (failing.steps as { id: string; type: string; config: object }[]).splice(1, 1, { id: "confirm", type: "http", config: { method: "GET", url: "http://127.0.0.1/blocked", headers: {} } });
    const s = await setup(failing);
    expect((await s.book()).run.state).toBe("failed");
    expect((await s.listed())[0]).toMatchObject({ status: "active", attention: true });
  });

  it("lets a takeover find the result of a booking attempt that is still committing: one booking, one confirmation", async () => {
    const s = await setup();
    const runId = (await s.agent.post(`/workflows/${s.wf.id}/runs`).send({ payload: { email: "mia@example.com", who: s.ana.id, at: at("14:00") } }).expect(202)).body.id as string;
    const a = gated();
    const b = gated();
    const first = advance({ ...deps(), owner: "worker-a", leaseMs: 600_000, executor: a.executor }, runId).catch((e: unknown) => e);
    await a.here;
    // Worker A looks stopped: its lease runs out and worker B takes the same attempt over.
    await db.update(runs).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(runs.id, runId));
    const second = advance({ ...deps(), owner: "worker-b", leaseMs: 600_000, executor: b.executor }, runId).catch((e: unknown) => e);
    await b.here;
    // A lock on the run row holds A after it inserted the booking, before it commits (its change row checks the run).
    let unlock!: () => void;
    const unlocked = new Promise<void>((r) => (unlock = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for("update");
      locked();
      await unlocked;
    });
    await isLocked;
    a.go();
    await lockWaiters(1);
    b.go();
    await lockWaiters(2);
    unlock();
    await holder;
    const [lost] = await Promise.all([first, second]);
    // A's result is fenced off by B's claim; B returns the stored result instead of failing.
    expect(String(lost)).toContain("under this worker's claim");
    expect(await pathOf(runId)).toEqual(["book:succeeded"]);
    const sent = mailSent.length;
    expect((await drive(runId)).state).toBe("waiting");
    expect(await pathOf(runId)).toEqual(["book:succeeded", "confirm:succeeded", "wait:waiting"]);
    expect(mailSent.slice(sent).map((m) => m.subject)).toEqual([expect.stringMatching(/^Booked BK-/)]);
    expect(await s.listed()).toHaveLength(1);
  });
});

describe("staff changes", () => {
  it("lets owners and operators list, cancel and reschedule; approvers, requesters and other workspaces cannot", async () => {
    const s = await setup();
    await s.book();
    const [b] = await s.listed();
    const operator = await member(s.agent, "operator");
    expect((await operator.get("/bookings").expect(200)).body).toHaveLength(1);
    for (const role of ["approver", "requester"] as const) {
      const m = await member(s.agent, role);
      await m.get("/bookings").expect(403);
      await m.post(`/bookings/${b!.id}/cancel`).send({ version: 1 }).expect(403);
      await m.post(`/bookings/${b!.id}/reschedule`).send({ version: 1, start: at("16:00") }).expect(403);
    }
    const other = await owner();
    expect((await other.agent.get("/bookings").expect(200)).body).toEqual([]);
    await other.agent.post(`/bookings/${b!.id}/cancel`).send({ version: 1 }).expect(404);
    await other.agent.post(`/bookings/${b!.id}/reschedule`).send({ version: 1, start: at("16:00") }).expect(404);
    await request(app.getHttpServer()).get("/bookings").expect(401);
    await operator.post(`/bookings/${b!.id}/cancel`).send({ version: 1 }).expect(200);
  });

  it("cancels once: a repeat is a duplicate, the reminder run is marked superseded and stops when it wakes", async () => {
    const s = await setup();
    const { runId } = await s.book();
    const [b] = await s.listed();
    const first = await s.agent.post(`/bookings/${b!.id}/cancel`).send({ version: 1 }).expect(200);
    expect(first.body).toMatchObject({ booking: { status: "cancelled", version: 2 } });
    expect((await s.agent.post(`/bookings/${b!.id}/cancel`).send({ version: 1 }).expect(200)).body).toMatchObject({ duplicate: true, booking: { version: 2 } });
    expect((await s.agent.post(`/bookings/${b!.id}/reschedule`).send({ version: 1, start: at("16:00") }).expect(409)).body.message).toBe("This booking changed since you loaded it. Reload and try again.");

    expect((await s.agent.get(`/runs/${runId}`).expect(200)).body).toMatchObject({ state: "waiting", superseded: true });
    const sent = mailSent.length;
    expect(await wake(runId)).toMatchObject({ state: "cancelled", error: "The booking was rescheduled or cancelled, so this run stopped before step remind." });
    expect(mailSent.length).toBe(sent);
    // The slot is free again.
    expect((await s.book()).run.state).toBe("waiting");
  });

  it("reschedules into one new run that resumes after the booking step, and the old reminder stops", async () => {
    const s = await setup();
    const old = await s.book();
    const [b] = await s.listed();
    const res = await s.agent.post(`/bookings/${b!.id}/reschedule`).send({ version: 1, start: at("16:00") }).expect(200);
    expect(res.body).toMatchObject({ booking: { version: 2, start: `${at("16:00")}:00+08:00`, end: `${at("17:00")}:00+08:00` } });
    const runId = res.body.runId as string;
    // The same request again, with the time written as UTC: the same operation, so the same run and no new version.
    const again = await s.agent.post(`/bookings/${b!.id}/reschedule`).send({ version: 1, start: `${year}-01-20T08:00:00Z` }).expect(200);
    expect(again.body).toMatchObject({ duplicate: true, runId, booking: { version: 2 } });

    const sent = mailSent.length;
    expect((await drive(runId)).state).toBe("waiting");
    expect(await pathOf(runId)).toEqual(["book:succeeded", "confirm:succeeded", "wait:waiting"]);
    expect(mailSent.slice(sent)).toEqual([{ to: "mia@example.com", subject: `Booked ${b!.reference}`, text: `${at("16:00")}:00+08:00 with Ana` }]);
    expect(await runRow(runId)).toMatchObject({ bookingVersion: 2, test: false });
    expect(await wake(old.runId)).toMatchObject({ state: "cancelled" });
    expect((await wake(runId)).state).toBe("succeeded");
    expect(mailSent.at(-1)).toEqual({ to: "mia@example.com", subject: `Reminder ${b!.reference}`, text: `See you at ${at("16:00")}:00+08:00` });
    expect((await db.select().from(runs).where(eq(runs.bookingId, b!.id))).map((r) => r.id).sort()).toEqual([old.runId, runId].sort());
  });

  it("checks the new time with the field's rules and refuses a taken time or a stale version", async () => {
    const s = await setup();
    await s.book();
    await s.book(at("18:00"));
    const b = (await s.listed()).find((x) => x.start.includes("T14:00"))!;
    const refuse = async (body: object, status: number) => (await s.agent.post(`/bookings/${b.id}/reschedule`).send(body).expect(status)).body.message;
    expect(await refuse({ version: 1, start: at("16:30") }, 400)).toEqual(["start: must start on a 60-minute slot, counted from midnight in Asia/Manila"]);
    expect(await refuse({ version: 1, start: "2020-01-20T14:00" }, 400)).toEqual(["start: must be in the future"]);
    expect(await refuse({ version: 1, start: at("18:00") }, 409)).toBe("That time is taken.");
    expect(await refuse({ version: 3, start: at("16:00") }, 409)).toBe("This booking changed since you loaded it. Reload and try again.");
    expect(await refuse({ start: at("16:00") }, 400)).toEqual(["version: Invalid input: expected number, received undefined"]);
    expect((await s.listed()).find((x) => x.id === b.id)).toMatchObject({ version: 1 });
  });

  it("gives one change and one run for concurrent identical requests, and one winner for different ones", async () => {
    const s = await setup();
    await s.book();
    const [b] = await s.listed();
    const before = (await db.select().from(runs)).length;
    const same = await Promise.all(Array.from({ length: 5 }, () => s.agent.post(`/bookings/${b!.id}/reschedule`).send({ version: 1, start: at("16:00") })));
    expect(same.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(same.filter((r) => !r.body.duplicate)).toHaveLength(1);
    expect(new Set(same.map((r) => r.body.runId)).size).toBe(1);
    expect((await db.select().from(runs)).length).toBe(before + 1);
    const mixed = await Promise.all(["17:00", "19:00", "20:00"].map((t) => s.agent.post(`/bookings/${b!.id}/reschedule`).send({ version: 2, start: at(t) })));
    expect(mixed.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await db.select().from(bookings).where(eq(bookings.id, b!.id)))[0]!.version).toBe(3);
  });

  it("sends a staff-started run's mail to the guest who booked, after a desk workflow moved the booking", async () => {
    const s = await setup();
    await s.book();
    const [b] = await s.listed();
    const desk = (await s.agent.post("/workflows").send({ name: "Desk", slug: `desk-${++seq}` }).expect(201)).body as { id: string };
    const deskFields = [
      { name: "email", label: "Desk email", type: "email", required: true },
      { name: "ref", label: "Reference", type: "text", required: true },
      { name: "when", label: "New time", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
    ];
    const move = { id: "move", type: "booking", config: { action: "reschedule", booking: "{{trigger.ref}}", start: "{{trigger.when}}" } };
    await s.agent.post(`/workflows/${desk.id}/versions`).send({ definition: { trigger: { type: "webhook", config: { fields: deskFields, hmacSecret: "desk_signing" } }, steps: [move, email("noted", "Moved {{steps.move.output.reference}}", "x")], edges: [{ from: "move", to: "noted", on: "done" }] }, publish: true }).expect(201);
    const deskRun = (await s.agent.post(`/workflows/${desk.id}/runs`).send({ payload: { email: "desk@example.com", ref: b!.reference, when: at("15:00") } }).expect(202)).body.id as string;
    const sent = mailSent.length;
    expect((await drive(deskRun)).state).toBe("succeeded");
    expect(mailSent.slice(sent).map((m) => m.to)).toEqual(["desk@example.com"]);

    const staff = mailSent.length;
    let version = 2;
    for (const time of ["16:00", "18:00"]) {
      const res = await s.agent.post(`/bookings/${b!.id}/reschedule`).send({ version, start: at(time) }).expect(200);
      version = res.body.booking.version as number;
      expect((await drive(res.body.runId)).state).toBe("waiting");
      expect((await wake(res.body.runId)).state).toBe("succeeded");
    }
    expect(mailSent.slice(staff).map((m) => [m.to, m.subject, m.text])).toEqual([
      ["mia@example.com", `Booked ${b!.reference}`, `${at("16:00")}:00+08:00 with Ana`],
      ["mia@example.com", `Reminder ${b!.reference}`, `See you at ${at("16:00")}:00+08:00`],
      ["mia@example.com", `Booked ${b!.reference}`, `${at("18:00")}:00+08:00 with Ana`],
      ["mia@example.com", `Reminder ${b!.reference}`, `See you at ${at("18:00")}:00+08:00`],
    ]);
  });

  it("answers a replayed change with what it did then, after later changes and after its time has passed", async () => {
    const s = await setup();
    await s.book();
    const [b] = await s.listed();
    const move = (version: number, time: string) => s.agent.post(`/bookings/${b!.id}/reschedule`).send({ version, start: at(time) });
    const cancel = (version: number) => s.agent.post(`/bookings/${b!.id}/cancel`).send({ version });
    const first = (await move(1, "16:00").expect(200)).body;
    await move(2, "18:00").expect(200);
    const replay = (await move(1, "16:00").expect(200)).body;
    expect(replay).toEqual({ duplicate: true, runId: first.runId, booking: first.booking });
    expect(replay.booking).toMatchObject({ version: 2, start: `${at("16:00")}:00+08:00`, end: `${at("17:00")}:00+08:00`, status: "active" });
    const cancelled = (await cancel(3).expect(200)).body;
    expect((await cancel(3).expect(200)).body).toEqual({ duplicate: true, booking: cancelled.booking });
    expect((await move(1, "16:00").expect(200)).body).toEqual(replay);
    expect((await move(1, "17:00").expect(409)).body.message).toBe("This booking changed since you loaded it. Reload and try again.");

    // Months after the appointment: identical replays still get their stored answers. An operator's session cookie is
    // sent as a header, since the test client's cookie jar would drop the owner's cookie under the moved clock.
    const operator = await member(s.agent, "operator");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${year + 1}-06-01T00:00:00Z`) });
    try {
      expect((await operator.post(`/bookings/${b!.id}/reschedule`).send({ version: 1, start: at("16:00") }).expect(200)).body).toEqual(replay);
      expect((await operator.post(`/bookings/${b!.id}/cancel`).send({ version: 3 }).expect(200)).body).toEqual({ duplicate: true, booking: cancelled.booking });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads staff's time in the booking's timezone even after the workflow's field moved to another zone", async () => {
    const s = await setup();
    await s.book();
    const [b] = await s.listed();
    // The published version's appointment field now says New York; the booking itself stays in Manila.
    const edited = spa() as { trigger: { config: { fields: { name: string; timezone?: string }[] } } };
    edited.trigger.config.fields = edited.trigger.config.fields.map((f) => (f.name === "at" ? { ...f, timezone: "America/New_York" } : f));
    await s.agent.post(`/workflows/${s.wf.id}/versions`).send({ definition: edited, publish: true }).expect(201);
    const body = { version: 1, start: at("16:00") };
    const sent = mailSent.length;
    const res = await s.agent.post(`/bookings/${b!.id}/reschedule`).send(body).expect(200);
    expect(res.body.booking).toMatchObject({ timezone: "Asia/Manila", start: `${at("16:00")}:00+08:00`, end: `${at("17:00")}:00+08:00` });
    expect((await drive(res.body.runId)).state).toBe("waiting");
    expect(mailSent.slice(sent).map((m) => [m.to, m.text])).toEqual([["mia@example.com", `${at("16:00")}:00+08:00 with Ana`]]);
    expect((await s.listed())[0]).toMatchObject({ start: `${at("16:00")}:00+08:00` });

    // The same request after the appointment time has passed gets the original run.
    const operator = await member(s.agent, "operator");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${year + 1}-06-01T00:00:00Z`) });
    try {
      expect((await operator.post(`/bookings/${b!.id}/reschedule`).send(body).expect(200)).body).toMatchObject({ duplicate: true, runId: res.body.runId });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to reschedule when the published version lost the booking step, or a later step reads one before it", async () => {
    const s = await setup();
    await s.book();
    const [b] = await s.listed();
    await s.agent.post(`/workflows/${s.wf.id}/versions`).send({ definition: { trigger: { type: "webhook", config: { fields } }, steps: [email("only", "Hi", "x")], edges: [] }, publish: true }).expect(201);
    expect((await s.agent.post(`/bookings/${b!.id}/reschedule`).send({ version: 1, start: at("16:00") }).expect(409)).body.message).toBe('Publish a version with booking step "book" to reschedule this booking.');

    const reads = spa([email("notify", "New booking", "x")], [{ from: "notify", to: "book" }]);
    (reads.steps as { id: string; config: { text?: string } }[]).find((x) => x.id === "confirm")!.config.text = "Desk note {{steps.notify.output.messageId}}";
    const t = await setup(reads);
    await t.book();
    const [c] = await t.listed();
    expect((await t.agent.post(`/bookings/${c!.id}/reschedule`).send({ version: 1, start: at("16:00") }).expect(409)).body.message).toBe('Step "confirm" reads step "notify", which ran before the booking, so a rescheduled run could not fill it in.');
  });
});

describe("MCP booking tools", () => {
  it("lists live bookings and cancels or reschedules them with the version it saw", async () => {
    const s = await setup();
    await s.book();
    await s.agent.post(`/workflows/${s.wf.id}/test-runs`).send({ definition: spa(), payload: { email: "mia@example.com", who: s.ana.id, at: at("15:00") } }).expect(202);
    const token = (await s.agent.post("/tokens").send({ name: "claude" }).expect(201)).body.token as string;
    const client = new Client({ name: "bookings-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content?: unknown; structuredContent?: unknown }> => {
      try {
        return await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    };

    const list = (await call("list_bookings", {})).structuredContent as { bookings: { reference: string; version: number }[] };
    expect(list.bookings).toHaveLength(1);
    const ref = list.bookings[0]!.reference;
    const moved = await call("reschedule_booking", { reference: ref, version: 1, start: at("16:00") });
    expect(moved.structuredContent).toMatchObject({ booking: { version: 2, start: `${at("16:00")}:00+08:00` }, runId: expect.any(String) });
    expect((await call("reschedule_booking", { reference: ref, version: 1, start: at("16:00") })).structuredContent).toMatchObject({ duplicate: true });
    const stale = await call("cancel_booking", { reference: ref, version: 1 });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain("changed since you loaded it");
    expect((await call("cancel_booking", { reference: "TEST-AAAAAA", version: 1 })).isError).toBe(true);
    expect((await call("cancel_booking", { reference: ref, version: 2 })).structuredContent).toMatchObject({ booking: { status: "cancelled", version: 3 } });
    await client.close();
  });
});
