import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../test/db";
import { EVENTS_CHANNEL, eventPayload, publishEvent, publishRunFinished, type LiveEvent } from "./events";
import { recordInbound } from "./conversations";
import { createDb, type Db } from "./index";
import { runs, users, workflows, workflowVersions } from "./schema";

let db: Db;
let pool: pg.Pool;
let listener: pg.Client;
const seen: LiveEvent[] = [];
const raw: string[] = [];

beforeAll(async () => {
  const fresh = await freshDatabase();
  ({ db, pool } = fresh);
  listener = new pg.Client({ connectionString: fresh.url });
  await listener.connect();
  await listener.query(`LISTEN ${EVENTS_CHANNEL}`);
  listener.on("notification", (n) => {
    raw.push(n.payload ?? "");
    seen.push(JSON.parse(n.payload ?? "{}") as LiveEvent);
  });
}, 120_000);

afterAll(async () => {
  await listener?.end();
  await pool?.end();
});

/** NOTIFY reaches the listener a moment after the commit. */
const settle = () => new Promise((r) => setTimeout(r, 150));

async function workspace(name = "Booking confirmation") {
  const [user] = await db.insert(users).values({ email: `${randomUUID()}@t.local`, passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: user!.id, name, slug: randomUUID().slice(0, 8) }).returning();
  const [version] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {}, published: true }).returning();
  return { userId: user!.id, versionId: version!.id };
}

it("builds a small payload with only workspaceId, kind, id, title and at", () => {
  const body = JSON.parse(eventPayload({ workspaceId: "w", kind: "run_failed", id: "r", title: "x".repeat(500) })!) as LiveEvent;
  expect(Object.keys(body).sort()).toEqual(["at", "id", "kind", "title", "workspaceId"]);
  expect(body.title.length).toBeLessThanOrEqual(80);
  expect(Buffer.byteLength(eventPayload({ workspaceId: "w", kind: "run_failed", id: "r", title: "é".repeat(500) })!)).toBeLessThan(1000);
});

it("publishes to the channel and never throws when the database refuses", async () => {
  seen.length = 0;
  await publishEvent(db, { workspaceId: "w1", kind: "run_failed", id: "r1", title: "Receipt archive" });
  await settle();
  expect(seen).toMatchObject([{ workspaceId: "w1", kind: "run_failed", id: "r1", title: "Receipt archive" }]);

  const log = vi.fn();
  const broken = { transaction: () => Promise.reject(new Error("connection lost: Receipt archive")) };
  await expect(publishEvent(broken as never, { workspaceId: "w1", kind: "run_failed", id: "r1", title: "Receipt archive" }, log)).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledOnce();
  // The log line names the kind and id, never the title or the payload.
  expect(JSON.stringify(log.mock.calls)).not.toContain("Receipt archive");
  expect(JSON.stringify(log.mock.calls)).toContain("run_failed");
});

it("publishes a finished live run with its workflow name and skips a test run", async () => {
  const { userId, versionId } = await workspace("Booking confirmation");
  const [live] = await db.insert(runs).values({ workflowVersionId: versionId, state: "succeeded" }).returning();
  const [failed] = await db.insert(runs).values({ workflowVersionId: versionId, state: "failed", error: "customer secret@mail.com bounced" }).returning();
  const [test] = await db.insert(runs).values({ workflowVersionId: versionId, state: "succeeded", test: true }).returning();
  const [liveTest] = await db.insert(runs).values({ workflowVersionId: versionId, state: "succeeded", test: true, live: true }).returning();
  seen.length = 0;
  raw.length = 0;
  await publishRunFinished(db, live!.id, "succeeded");
  await publishRunFinished(db, failed!.id, "failed");
  await publishRunFinished(db, test!.id, "succeeded");
  await publishRunFinished(db, liveTest!.id, "succeeded");
  await settle();
  expect(seen.map((e) => [e.kind, e.id, e.title, e.workspaceId])).toEqual([
    ["run_succeeded", live!.id, "Booking confirmation", userId],
    ["run_failed", failed!.id, "Booking confirmation", userId],
    ["run_succeeded", liveTest!.id, "Booking confirmation", userId],
  ]);
  // The run's error text is never part of the event.
  expect(raw.join("")).not.toContain("secret@mail.com");
});

it("a run lookup that fails is logged and does not throw", async () => {
  const log = vi.fn();
  const broken = { select: () => { throw new Error("down"); } };
  await expect(publishRunFinished(broken as never, randomUUID(), "failed", log)).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledOnce();
});

it("announces a new chat message with the channel and no message text, once per message", async () => {
  const { userId } = await workspace();
  seen.length = 0;
  raw.length = 0;
  const msg = { userId, channel: "messenger" as const, externalId: "psid-1", text: "My card number is 4111 1111 1111 1111, please call me", at: new Date() };
  const first = await db.transaction((tx) => recordInbound(tx, { ...msg, mid: "m1" }));
  await db.transaction((tx) => recordInbound(tx, { ...msg, mid: "m1" }));
  await db.transaction((tx) => recordInbound(tx, { ...msg, mid: "m2" }));
  await settle();
  expect(seen).toHaveLength(2);
  expect(seen[0]).toMatchObject({ workspaceId: userId, kind: "conversation_new", id: first.id, title: "Messenger" });
  const wire = raw.join("");
  expect(wire).not.toContain("4111");
  expect(wire).not.toContain("psid-1");
  expect(wire).not.toContain("call me");
});

it("sends nothing when the message transaction rolls back", async () => {
  const { userId } = await workspace();
  seen.length = 0;
  await db.transaction(async (tx) => {
    await recordInbound(tx, { userId, channel: "telegram", externalId: "c9", mid: "r1", text: "hello", at: new Date() });
    tx.rollback();
  }).catch(() => undefined);
  await settle();
  expect(seen).toEqual([]);
});

it("keeps working through a dropped connection to the listener", async () => {
  // A second pool, so ending it does not affect the shared one.
  const other = createDb(pool.options.connectionString!);
  await other.pool.end();
  await expect(publishEvent(other.db, { workspaceId: "w", kind: "run_failed", id: "r", title: "t" }, () => undefined)).resolves.toBeUndefined();
});
