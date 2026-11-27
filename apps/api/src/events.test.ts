import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { joinWorkspace, publishEvent, sessions, users, type Db, type EventKind } from "@daloy/db";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { sha256 } from "./http";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let base: string;
const open: Stream[] = [];

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  // A short heartbeat, so the test sees one without waiting 25 seconds.
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false, eventsHeartbeatMs: 60 });
  await app.init();
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
  base = await app.getUrl();
}, 120_000);

afterEach(() => {
  open.splice(0).forEach((s) => s.close());
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

const PASSWORD = "correct horse battery";
let seq = 0;
type Agent = ReturnType<typeof request.agent>;

async function owner() {
  const agent = request.agent(server);
  const res = await agent.post("/auth/register").send({ email: `live${++seq}@test.local`, password: PASSWORD }).expect(201);
  const cookie = (res.headers["set-cookie"] as unknown as string[]).map((c) => c.split(";")[0]).join("; ");
  return { agent, cookie, workspaceId: res.body.id as string };
}

/** A member added straight in the database with a live session. */
async function member(workspaceId: string, role: "operator" | "approver" | "requester") {
  const [u] = await db.insert(users).values({ email: `live${++seq}@test.local`, passwordHash: await hash(PASSWORD) }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return { agent: request.agent(server).set("Cookie", `daloy_session=${token}`) as Agent, cookie: `daloy_session=${token}` };
}

type Stream = { status: number; headers: IncomingHttpHeaders; text: () => string; events: () => { kind: EventKind; id: string; title: string }[]; ended: () => boolean; close: () => void };

/** Opens GET /events and collects whatever the server writes. Resolves once the response headers arrive. */
function stream(cookie?: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/events`, { headers: cookie ? { cookie } : {} }, (res) => {
      let buf = "";
      let ended = false;
      res.setEncoding("utf8");
      res.on("data", (d: string) => (buf += d));
      res.on("end", () => (ended = true));
      res.on("close", () => (ended = true));
      const s: Stream = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => buf,
        events: () => [...buf.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]!) as { kind: EventKind; id: string; title: string }),
        ended: () => ended,
        close: () => req.destroy(),
      };
      open.push(s);
      resolve(s);
    });
    req.on("error", (err) => { if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err); });
    req.end();
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emit = (workspaceId: string, kind: EventKind, title = "Booking confirmation", id = "11111111-1111-4111-8111-111111111111") => publishEvent(db, { workspaceId, kind, id, title });

describe("GET /events access", () => {
  it("needs a session", async () => {
    expect((await stream()).status).toBe(401);
  });

  it("opens for the owner and an operator, and is refused for an approver and a requester", async () => {
    const o = await owner();
    expect((await stream(o.cookie)).status).toBe(200);
    expect((await stream((await member(o.workspaceId, "operator")).cookie)).status).toBe(200);
    expect((await stream((await member(o.workspaceId, "approver")).cookie)).status).toBe(403);
    expect((await stream((await member(o.workspaceId, "requester")).cookie)).status).toBe(403);
  });
});

describe("the stream itself", () => {
  it("sends event-stream headers that stop proxies buffering, a retry delay, and a heartbeat comment", async () => {
    const s = await stream((await owner()).cookie);
    expect(s.headers["content-type"]).toContain("text/event-stream");
    expect(s.headers["cache-control"]).toContain("no-cache");
    expect(s.headers["cache-control"]).toContain("no-transform");
    expect(s.headers["x-accel-buffering"]).toBe("no");
    expect(s.headers["content-encoding"]).toBeUndefined();
    await wait(250);
    expect(s.text()).toMatch(/^retry: \d+$/m);
    expect(s.text().match(/^: heartbeat$/gm)!.length).toBeGreaterThanOrEqual(2);
  });

  it("delivers an event with an id, as the kind, id and title only", async () => {
    const o = await owner();
    const s = await stream(o.cookie);
    await wait(100);
    await emit(o.workspaceId, "handoff_requested", "Messenger", "22222222-2222-4222-8222-222222222222");
    await wait(300);
    expect(s.text()).toMatch(/^id: \d+$/m);
    expect(s.events()).toEqual([{ kind: "handoff_requested", id: "22222222-2222-4222-8222-222222222222", title: "Messenger", at: expect.any(String) }]);
    // The workspace id is routing information, not something to hand to the browser.
    expect(s.text()).not.toContain(o.workspaceId);
  });

  it("never sends another workspace's event", async () => {
    const a = await owner();
    const b = await owner();
    const sa = await stream(a.cookie);
    const sb = await stream(b.cookie);
    await wait(100);
    await emit(a.workspaceId, "run_failed", "A's run");
    await emit(b.workspaceId, "run_failed", "B's run");
    await wait(300);
    expect(sa.events().map((e) => e.title)).toEqual(["A's run"]);
    expect(sb.events().map((e) => e.title)).toEqual(["B's run"]);
  });

  it("an operator receives the workspace's events", async () => {
    const o = await owner();
    const s = await stream((await member(o.workspaceId, "operator")).cookie);
    await wait(100);
    await emit(o.workspaceId, "conversation_new", "Telegram");
    await wait(300);
    expect(s.events().map((e) => e.kind)).toEqual(["conversation_new"]);
  });

  it("drops a malformed or unknown notification without closing the stream", async () => {
    const o = await owner();
    const s = await stream(o.cookie);
    await wait(100);
    await pool.query("select pg_notify('kymavo_events', 'not json')");
    await pool.query("select pg_notify('kymavo_events', $1)", [JSON.stringify({ workspaceId: o.workspaceId, kind: "other", id: "x", title: "t", at: "now" })]);
    await emit(o.workspaceId, "run_failed", "After");
    await wait(300);
    expect(s.events().map((e) => e.title)).toEqual(["After"]);
  });

  it("allows 5 streams per user, refuses a 6th, and frees a slot when one disconnects", async () => {
    const o = await owner();
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => stream(o.cookie)));
    expect(five.every((s) => s.status === 200)).toBe(true);
    expect((await stream(o.cookie)).status).toBe(429);
    // Another user is not affected by this user's streams.
    expect((await stream((await owner()).cookie)).status).toBe(200);
    five[0]!.close();
    await wait(200);
    expect((await stream(o.cookie)).status).toBe(200);
  });

  it("ends the stream after the person signs out", async () => {
    const o = await owner();
    const s = await stream(o.cookie);
    await o.agent.post("/auth/logout").expect(204).catch(() => undefined);
    await wait(400);
    expect(s.ended()).toBe(true);
  });
});

describe("notification preferences", () => {
  it("needs a session, and approvers have none", async () => {
    await request(server).get("/settings/notifications").expect(401);
    const o = await owner();
    await (await member(o.workspaceId, "approver")).agent.get("/settings/notifications").expect(403);
  });

  it("starts with chats, handoff and failed runs on and successful runs off", async () => {
    const { body } = await (await owner()).agent.get("/settings/notifications").expect(200);
    expect(body).toEqual({ chats: true, handoff: true, runsSucceeded: false, runsFailed: true });
  });

  it("saves per person, and refuses a value it does not know", async () => {
    const o = await owner();
    const op = await member(o.workspaceId, "operator");
    await o.agent.put("/settings/notifications").send({ chats: false, handoff: true, runsSucceeded: true, runsFailed: false }).expect(200);
    expect((await o.agent.get("/settings/notifications").expect(200)).body).toEqual({ chats: false, handoff: true, runsSucceeded: true, runsFailed: false });
    expect((await op.agent.get("/settings/notifications").expect(200)).body.chats).toBe(true);
    await o.agent.put("/settings/notifications").send({ chats: "yes" }).expect(400);
    await o.agent.put("/settings/notifications").send({ chats: true, handoff: true, runsSucceeded: true, runsFailed: true, extra: 1 }).expect(400);
  });

  it("filters the stream by the saved choices, and a change applies to a stream that is already open", async () => {
    const o = await owner();
    const s = await stream(o.cookie);
    await wait(100);
    // Defaults: chats and failures arrive, successes do not.
    await emit(o.workspaceId, "conversation_new", "default chat");
    await emit(o.workspaceId, "run_succeeded", "default success");
    await emit(o.workspaceId, "run_failed", "default failure");
    await wait(300);
    expect(s.events().map((e) => e.title)).toEqual(["default chat", "default failure"]);

    await o.agent.put("/settings/notifications").send({ chats: false, handoff: false, runsSucceeded: true, runsFailed: false }).expect(200);
    await emit(o.workspaceId, "conversation_new", "later chat");
    await emit(o.workspaceId, "handoff_requested", "later handoff");
    await emit(o.workspaceId, "run_succeeded", "later success");
    await emit(o.workspaceId, "run_failed", "later failure");
    await wait(300);
    expect(s.events().map((e) => e.title)).toEqual(["default chat", "default failure", "later success"]);
  });

  it("one person's choices do not filter another person's stream", async () => {
    const o = await owner();
    const op = await member(o.workspaceId, "operator");
    await o.agent.put("/settings/notifications").send({ chats: false, handoff: false, runsSucceeded: false, runsFailed: false }).expect(200);
    const so = await stream(o.cookie);
    const sp = await stream(op.cookie);
    await wait(100);
    await emit(o.workspaceId, "handoff_requested", "Messenger");
    await wait(300);
    expect(so.events()).toEqual([]);
    expect(sp.events().map((e) => e.kind)).toEqual(["handoff_requested"]);
  });
});
