import { randomBytes } from "node:crypto";
import { joinWorkspace, runs, sessions, users, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { sha256 } from "./http";

// GET /workflows/overview: per automation run counts, trigger, owner and apps, with no cap on the number of runs.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
type Agent = ReturnType<typeof request.agent>;

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
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

const PASSWORD = "correct horse battery";
let seq = 0;

async function owner() {
  const agent = request.agent(server);
  const email = `ov${++seq}@test.local`;
  const res = await agent.post("/auth/register").send({ email, password: PASSWORD }).expect(201);
  return { agent, email, id: res.body.id as string };
}

/** A member added straight in the database with a live session. */
async function member(ownerAgent: Agent, role: "operator" | "approver" | "requester") {
  const workspaceId = (await ownerAgent.get("/auth/me").expect(200)).body.workspaceId as string;
  const [u] = await db.insert(users).values({ email: `ov-member${++seq}@test.local`, passwordHash: await hash(PASSWORD) }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}

type Def = { trigger: object; steps: object[]; edges: object[] };
const CONFIGS: Record<string, object> = {
  delay: { seconds: 1 },
  slack: { text: "Hello" },
  sheets: { columns: ["{{trigger.email}}"] },
  paymongo_link: { amount: "5", description: "Order", reference: "ORD-1" },
};
const chain = (trigger: object, types: string[]): Def => ({
  trigger,
  steps: types.map((type, i) => ({ id: `s${i}`, type, config: CONFIGS[type] ?? {} })),
  edges: types.slice(1).map((_, i) => ({ from: `s${i}`, to: `s${i + 1}` })),
});
const delays = (trigger: object) => chain(trigger, ["delay", "delay"]);

/** Creates an automation and saves one version. Returns its id and the version's id, which runs hang on. */
async function automation(agent: Agent, definition: Def, publish: boolean) {
  const wf = await agent.post("/workflows").send({ name: `Auto ${++seq}`, slug: `ov-${seq}` }).expect(201);
  const v = await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish }).expect(201);
  return { id: wf.body.id as string, versionId: v.body.id as string };
}

const addRuns = (versionId: string, rows: { state: "succeeded" | "failed" | "running"; at: Date; test?: boolean }[]) =>
  db.insert(runs).values(rows.map((r) => ({ workflowVersionId: versionId, state: r.state, test: r.test ?? false, createdAt: r.at })));

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

/** The calendar day of an instant in a time zone, as days since 1970, computed by ICU rather than by the database. */
const dayOf = (at: Date, timeZone: string) => {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at).split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!) / 86_400_000;
};

type Overview = { id: string; trigger: string | null; owner: { email: string }; apps: string[]; runs: { today: number; week: number; succeeded: number; failed: number; days: { total: number; failed: boolean }[] } };
const overview = async (agent: Agent, query = "") => (await agent.get(`/workflows/overview${query}`).expect(200)).body as Overview[];
const rowOf = (rows: Overview[], id: string) => rows.find((r) => r.id === id)!;

describe("GET /workflows/overview", () => {
  it("needs a session, and the same role as the list", async () => {
    await request(server).get("/workflows/overview").expect(401);
    const o = await owner();
    expect(await overview(o.agent)).toEqual([]);
    await (await member(o.agent, "operator")).get("/workflows/overview").expect(200);
    await (await member(o.agent, "approver")).get("/workflows/overview").expect(403);
    await (await member(o.agent, "requester")).get("/workflows/overview").expect(403);
  });

  it("is not captured by the :id route", async () => {
    const o = await owner();
    await o.agent.get("/workflows/overview").expect(200);
    await o.agent.get("/workflows/not-a-uuid").expect(400);
  });

  it("returns one entry per automation, with zero counts when there are no runs", async () => {
    const o = await owner();
    const a = await automation(o.agent, delays({ type: "manual", config: {} }), false);
    const b = await automation(o.agent, delays({ type: "manual", config: {} }), true);
    const rows = await overview(o.agent);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(rowOf(rows, a.id).runs).toEqual({ today: 0, week: 0, succeeded: 0, failed: 0, days: Array.from({ length: 7 }, () => ({ total: 0, failed: false })) });
  });

  it("counts every run of the week, with no cap at 50", async () => {
    const o = await owner();
    const a = await automation(o.agent, delays({ type: "manual", config: {} }), true);
    await addRuns(a.versionId, Array.from({ length: 120 }, () => ({ state: "succeeded" as const, at: ago(0.01) })));
    const r = rowOf(await overview(o.agent), a.id).runs;
    expect(r.today).toBe(120);
    expect(r.week).toBe(120);
    expect(r.succeeded).toBe(120);
    expect(r.days[6]).toEqual({ total: 120, failed: false });
  });

  it("leaves out test runs and runs older than seven days, and counts failures", async () => {
    const o = await owner();
    const a = await automation(o.agent, delays({ type: "manual", config: {} }), true);
    await addRuns(a.versionId, [
      { state: "succeeded", at: ago(0.01) },
      { state: "failed", at: ago(0.02) },
      { state: "running", at: ago(0.03) },
      { state: "succeeded", at: ago(0.04), test: true },
      { state: "succeeded", at: ago(24 * 9) },
    ]);
    const r = rowOf(await overview(o.agent), a.id).runs;
    expect(r).toMatchObject({ today: 3, week: 3, succeeded: 1, failed: 1 });
    expect(r.days[6]).toEqual({ total: 3, failed: true });
    expect(r.days.slice(0, 6).every((d) => d.total === 0)).toBe(true);
  });

  it("counts the same runs on the same days as an independent calculation, in any time zone", async () => {
    const o = await owner();
    const a = await automation(o.agent, delays({ type: "manual", config: {} }), true);
    const offsets = [0.02, 1, 5, 13, 25, 49, 24 * 5 + 3, 24 * 6 + 11];
    await addRuns(a.versionId, offsets.map((h, i) => ({ state: i % 3 === 0 ? ("failed" as const) : ("succeeded" as const), at: ago(h) })));
    const now = new Date();
    for (const tz of ["Asia/Manila", "Etc/GMT+12", "Pacific/Kiritimati"]) {
      const expected = Array.from({ length: 7 }, () => ({ total: 0, failed: false }));
      offsets.forEach((h, i) => {
        const back = dayOf(now, tz) - dayOf(ago(h), tz);
        if (back < 0 || back > 6) return;
        expected[6 - back]!.total += 1;
        if (i % 3 === 0) expected[6 - back]!.failed = true;
      });
      const r = rowOf(await overview(o.agent, `?tz=${encodeURIComponent(tz)}`), a.id).runs;
      expect(r.days, tz).toEqual(expected);
      expect(r.today, tz).toBe(expected[6]!.total);
      expect(r.week, tz).toBe(expected.reduce((n, d) => n + d.total, 0));
    }
  });

  it("refuses a time zone that does not exist, and a long or odd one", async () => {
    const o = await owner();
    await o.agent.get("/workflows/overview?tz=Not/AZone").expect(400);
    await o.agent.get(`/workflows/overview?tz=${"x".repeat(80)}`).expect(400);
    await o.agent.get("/workflows/overview?tz='; drop table runs; --").expect(400);
    await o.agent.get("/workflows/overview?tz=").expect(400);
  });

  it("names the trigger type from the live version, or the newest draft", async () => {
    const o = await owner();
    const form = await automation(o.agent, delays({ type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }] } }), true);
    const draft = await automation(o.agent, delays({ type: "manual", config: {} }), false);
    const rows = await overview(o.agent);
    expect(rowOf(rows, form.id).trigger).toBe("form");
    expect(rowOf(rows, draft.id).trigger).toBe("manual");
    // A new draft over a live version does not change what is live.
    await o.agent.post(`/workflows/${form.id}/versions`).send({ definition: delays({ type: "manual", config: {} }), publish: false }).expect(201);
    expect(rowOf(await overview(o.agent), form.id).trigger).toBe("form");
  });

  it("lists the apps the steps need once each, in step order", async () => {
    const o = await owner();
    const a = await automation(o.agent, chain({ type: "manual", config: {} }, ["slack", "delay", "sheets", "slack", "paymongo_link"]), false);
    const plain = await automation(o.agent, delays({ type: "manual", config: {} }), false);
    const rows = await overview(o.agent);
    expect(rowOf(rows, a.id).apps).toEqual(["slack", "google_sheets", "paymongo"]);
    expect(rowOf(rows, plain.id).apps).toEqual([]);
  });

  it("names the workspace owner, for a member as well", async () => {
    const o = await owner();
    const a = await automation(o.agent, delays({ type: "manual", config: {} }), false);
    const op = await member(o.agent, "operator");
    expect(rowOf(await overview(o.agent), a.id).owner).toEqual({ email: o.email });
    expect(rowOf(await overview(op), a.id).owner).toEqual({ email: o.email });
  });

  it("shows a workspace only its own automations and runs", async () => {
    const mine = await owner();
    const theirs = await owner();
    const a = await automation(mine.agent, delays({ type: "manual", config: {} }), true);
    const b = await automation(theirs.agent, delays({ type: "manual", config: {} }), true);
    await addRuns(a.versionId, [{ state: "succeeded", at: ago(0.01) }]);
    await addRuns(b.versionId, [{ state: "failed", at: ago(0.01) }, { state: "failed", at: ago(0.02) }]);
    const mineRows = await overview(mine.agent);
    expect(mineRows.map((r) => r.id)).toEqual([a.id]);
    expect(mineRows[0]!.runs).toMatchObject({ today: 1, failed: 0 });
    const theirRows = await overview(theirs.agent);
    expect(theirRows.map((r) => r.id)).toEqual([b.id]);
    expect(theirRows[0]!.runs).toMatchObject({ today: 2, failed: 2 });
    expect(theirRows[0]!.owner).toEqual({ email: theirs.email });
  });
});
