import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db } from "./index";
import { DEFAULT_RETIRED_SECRET_MAX_AGE_DAYS, purgeRetiredSecrets, retiredSecretMaxAgeDays } from "./retired-secrets";
import * as schema from "./schema";
import { bookings, calendarEvents, connections, deliveries, emailSources, mailSenders, payments, requests, resources, retiredSecrets, runs, secrets, stepRuns, users, workflows, workflowVersions } from "./schema";

let db: Db;
let pool: Pool;
const key = randomBytes(32);
let seq = 0;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
}, 120_000);

afterAll(async () => {
  await pool?.end();
});

const DAY_MS = 86_400_000;
const forms = (v: string) => [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2)];

async function makeWorkspace() {
  const [user] = await db.insert(users).values({ email: `purge${++seq}@test.local`, passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: user!.id, name: "Flow", slug: `flow-${seq}` }).returning();
  const [version] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  return { userId: user!.id, workflowId: wf!.id, versionId: version!.id };
}

async function seedRetired(userId: string, name: string, plaintext: string, retiredAt: Date) {
  const enc = encryptSecret(key, userId, name, plaintext);
  const [row] = await db.insert(retiredSecrets).values({ userId, name, ...enc, retiredAt }).returning();
  return row!;
}

describe("retiredSecretMaxAgeDays", () => {
  it("defaults to 90 when unset or empty and accepts positive integers", () => {
    expect(DEFAULT_RETIRED_SECRET_MAX_AGE_DAYS).toBe(90);
    expect(retiredSecretMaxAgeDays({})).toBe(90);
    expect(retiredSecretMaxAgeDays({ RETIRED_SECRETS_MAX_AGE_DAYS: "" })).toBe(90);
    expect(retiredSecretMaxAgeDays({ RETIRED_SECRETS_MAX_AGE_DAYS: "1" })).toBe(1);
    expect(retiredSecretMaxAgeDays({ RETIRED_SECRETS_MAX_AGE_DAYS: "30" })).toBe(30);
    expect(retiredSecretMaxAgeDays({ RETIRED_SECRETS_MAX_AGE_DAYS: "365" })).toBe(365);
  });

  it("rejects zero, negative, fractional and non-numeric values", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "90d", " 90"]) {
      expect(() => retiredSecretMaxAgeDays({ RETIRED_SECRETS_MAX_AGE_DAYS: bad }), bad).toThrow(/RETIRED_SECRETS_MAX_AGE_DAYS/);
    }
  });
});

describe("purgeRetiredSecrets", () => {
  it("keeps retired secrets newer than 90 days untouched", async () => {
    const now = new Date("2026-11-19T12:00:00Z");
    const ws = await makeWorkspace();
    const recentVal = `recent-sec-${randomBytes(4).toString("hex")}`;
    await seedRetired(ws.userId, "api_key", recentVal, new Date(now.getTime() - 89 * DAY_MS));
    const [run] = await db.insert(runs).values({ workflowVersionId: ws.versionId, state: "failed", triggerPayload: { note: recentVal }, error: recentVal }).returning();

    const summary = await purgeRetiredSecrets(db, key, { now });
    expect(summary).toEqual({ workspaces: 0, retiredDeleted: 0, rowsScrubbed: 0 });

    const left = await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, ws.userId));
    expect(left).toHaveLength(1);
    const [row] = await db.select().from(runs).where(eq(runs.id, run!.id));
    expect(row!.error).toBe(recentVal);
  });

  it("scrubs every form across all history and state tables and deletes retired rows at or past 90 days", async () => {
    const now = new Date("2026-11-19T12:00:00Z");
    const ws = await makeWorkspace();
    const v1 = `old"se\\cret\nval+${randomBytes(4).toString("hex")}%`;
    const [raw, jsonEsc, urlEnc, formEnc] = forms(v1);
    await seedRetired(ws.userId, "tricky", v1, new Date(now.getTime() - 90 * DAY_MS));

    // Seed every scrubbable table with different encodings of v1, plus one clean run that should not be counted as scrubbed.
    const [r1] = await db
      .insert(runs)
      .values({ workflowVersionId: ws.versionId, state: "failed", triggerPayload: { raw, [raw!]: jsonEsc, nested: [urlEnc, formEnc] }, error: `run ${raw} ${urlEnc}` })
      .returning();
    const [cleanRun] = await db
      .insert(runs)
      .values({ workflowVersionId: ws.versionId, state: "succeeded", triggerPayload: { note: "clean" }, error: null })
      .returning();
    const [s1] = await db
      .insert(stepRuns)
      .values({ runId: r1!.id, stepId: "call", attempt: 1, state: "failed", input: { body: jsonEsc }, output: { body: `${urlEnc}&${formEnc}` }, error: `step ${raw}` })
      .returning();
    const [d1] = await db
      .insert(deliveries)
      .values({ userId: ws.userId, runId: r1!.id, stepId: "send", provider: "slack", reference: `REF-${raw}`, payload: { text: `p ${jsonEsc}` }, state: "failed", lastError: `err ${urlEnc}`, result: { msg: formEnc! } })
      .returning();
    const [req1] = await db
      .insert(requests)
      .values({ userId: ws.userId, workflowId: ws.workflowId, runId: r1!.id, reference: `REQ-P${seq}`, submissionKey: randomUUID(), subject: `subj ${raw}` })
      .returning();
    const connEnc = encryptSecret(key, ws.userId, "connection:slack", "xoxb-unused");
    await db.insert(connections).values({ userId: ws.userId, provider: "slack", status: "failed", authMethod: "token", account: "Office", credentialCiphertext: connEnc.ciphertext, credentialIv: connEnc.iv, credentialAuthTag: connEnc.authTag, lastError: `conn ${urlEnc}` });
    const imapEnc = encryptSecret(key, ws.userId, `imap:${ws.workflowId}`, "imap-pass");
    const [es1] = await db
      .insert(emailSources)
      .values({ workflowId: ws.workflowId, host: "imap.office.example", username: "a@b.test", folder: "INBOX", ...imapEnc, status: "failed", lastError: `imap ${formEnc}` })
      .returning();
    const gmailEnc = encryptSecret(key, ws.userId, "gmail_app_password", "app-pass");
    await db.insert(mailSenders).values({ userId: ws.userId, address: "a@b.test", status: "failed", authMethod: "app_password", passwordCiphertext: gmailEnc.ciphertext, passwordIv: gmailEnc.iv, passwordAuthTag: gmailEnc.authTag, lastError: `mail ${raw}` });
    const [res] = await db.insert(resources).values({ userId: ws.userId, name: "Room 1" }).returning();
    const [bk] = await db
      .insert(bookings)
      .values({ userId: ws.userId, test: false, reference: `BK-P${seq}`, resourceId: res!.id, during: sql`tstzrange(now() + interval '1 day', now() + interval '25 hours')` as unknown as string, timezone: "UTC", workflowId: ws.workflowId, runId: r1!.id })
      .returning();
    await db.insert(calendarEvents).values({ bookingId: bk!.id, userId: ws.userId, title: `Event ${raw}`, description: `Desc ${urlEnc}` });
    const [pay1] = await db
      .insert(payments)
      .values({ userId: ws.userId, workflowId: ws.workflowId, runId: r1!.id, stepId: "pay", reference: `PAY-${raw}`, amountCentavos: 1000, livemode: false, providerSessionId: `cs_${seq}`, url: "https://pay.example/1" })
      .returning();

    const summary = await purgeRetiredSecrets(db, key, { now });
    expect(summary).toEqual({ workspaces: 1, retiredDeleted: 1, rowsScrubbed: 9 });

    expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, ws.userId))).toEqual([]);

    const stored = [
      (await db.select().from(runs).where(eq(runs.id, r1!.id)))[0],
      (await db.select().from(stepRuns).where(eq(stepRuns.id, s1!.id)))[0],
      (await db.select().from(deliveries).where(eq(deliveries.id, d1!.id)))[0],
      (await db.select().from(requests).where(eq(requests.id, req1!.id)))[0],
      (await db.select().from(connections).where(and(eq(connections.userId, ws.userId), eq(connections.provider, "slack"))))[0],
      (await db.select().from(emailSources).where(eq(emailSources.id, es1!.id)))[0],
      (await db.select().from(mailSenders).where(eq(mailSenders.userId, ws.userId)))[0],
      (await db.select().from(calendarEvents).where(eq(calendarEvents.bookingId, bk!.id)))[0],
      (await db.select().from(payments).where(eq(payments.id, pay1!.id)))[0],
    ];
    const dumped = JSON.stringify(stored);
    for (const f of forms(v1)) {
      expect(dumped).not.toContain(f);
      expect(dumped).not.toContain(JSON.stringify(f).slice(1, -1));
    }
    expect(dumped).toContain("[secret]");

    // Clean run remained intact.
    const [cleanAfter] = await db.select().from(runs).where(eq(runs.id, cleanRun!.id));
    expect(cleanAfter!.triggerPayload).toEqual({ note: "clean" });
  });

  it("leaves other workspaces and newer retired copies of the same secret name intact", async () => {
    const now = new Date("2026-11-19T12:00:00Z");
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const oldVal = `old-same-${randomBytes(4).toString("hex")}`;
    const newerVal = `new-same-${randomBytes(4).toString("hex")}`;
    const currentVal = `cur-same-${randomBytes(4).toString("hex")}`;

    await seedRetired(wsA.userId, "token", oldVal, new Date(now.getTime() - 120 * DAY_MS));
    const keptRow = await seedRetired(wsA.userId, "token", newerVal, new Date(now.getTime() - 10 * DAY_MS));
    await db.insert(secrets).values({ userId: wsA.userId, name: "token", ...encryptSecret(key, wsA.userId, "token", currentVal) });
    // Workspace B happens to hold the same text in its own run and its own recent retired secret.
    await seedRetired(wsB.userId, "token", oldVal, new Date(now.getTime() - 5 * DAY_MS));
    const [runA] = await db.insert(runs).values({ workflowVersionId: wsA.versionId, state: "succeeded", triggerPayload: { old: oldVal, newer: newerVal, cur: currentVal } }).returning();
    const [runB] = await db.insert(runs).values({ workflowVersionId: wsB.versionId, state: "succeeded", triggerPayload: { old: oldVal } }).returning();

    const summary = await purgeRetiredSecrets(db, key, { now });
    expect(summary).toEqual({ workspaces: 1, retiredDeleted: 1, rowsScrubbed: 1 });

    // Only the old retired copy in wsA was deleted; the newer copy and current secret remain.
    const leftA = await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, wsA.userId));
    expect(leftA.map((r) => r.id)).toEqual([keptRow.id]);
    expect(decryptSecret(key, wsA.userId, "token", leftA[0]!)).toBe(newerVal);

    const [afterA] = await db.select().from(runs).where(eq(runs.id, runA!.id));
    expect(afterA!.triggerPayload).toEqual({ old: "[secret]", newer: newerVal, cur: currentVal });

    // Workspace B is completely untouched.
    const leftB = await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, wsB.userId));
    expect(leftB).toHaveLength(1);
    const [afterB] = await db.select().from(runs).where(eq(runs.id, runB!.id));
    expect(afterB!.triggerPayload).toEqual({ old: oldVal });
  });

  it("handles an undecryptable retired row without deleting it or breaking other workspaces", async () => {
    const now = new Date("2026-11-19T12:00:00Z");
    const wsBad = await makeWorkspace();
    const wsGood = await makeWorkspace();
    const goodVal = `good-val-${randomBytes(4).toString("hex")}`;

    // Insert a corrupted row encrypted with the wrong key in wsBad, plus a valid expired row in wsGood.
    const wrongEnc = encryptSecret(randomBytes(32), wsBad.userId, "broken", "unreadable");
    const [badRow] = await db.insert(retiredSecrets).values({ userId: wsBad.userId, name: "broken", ...wrongEnc, retiredAt: new Date(now.getTime() - 100 * DAY_MS) }).returning();
    await seedRetired(wsGood.userId, "ok", goodVal, new Date(now.getTime() - 100 * DAY_MS));
    const [goodRun] = await db.insert(runs).values({ workflowVersionId: wsGood.versionId, state: "failed", triggerPayload: {}, error: goodVal }).returning();

    const summary = await purgeRetiredSecrets(db, key, { now });
    expect(summary).toEqual({ workspaces: 1, retiredDeleted: 1, rowsScrubbed: 1 });

    // Bad row was NOT deleted because it could not be scrubbed.
    expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.id, badRow!.id))).toHaveLength(1);
    // Good workspace was still scrubbed and deleted cleanly.
    expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, wsGood.userId))).toEqual([]);
    expect((await db.select().from(runs).where(eq(runs.id, goodRun!.id)))[0]!.error).toBe("[secret]");
  });

  it("rolls back atomically and keeps the retired_secrets row if scrubbing fails mid-transaction", async () => {
    const now = new Date("2026-11-19T12:00:00Z");
    const ws = await makeWorkspace();
    const val = `atomic-sec-${randomBytes(4).toString("hex")}`;
    const retired = await seedRetired(ws.userId, "atomic", val, new Date(now.getTime() - 100 * DAY_MS));
    const [r] = await db.insert(runs).values({ workflowVersionId: ws.versionId, state: "failed", triggerPayload: { v: val }, error: val }).returning();
    await db.insert(stepRuns).values({ runId: r!.id, stepId: "s", attempt: 1, state: "failed", input: { v: val }, output: { v: val }, error: val });

    // Install a real Postgres trigger that fails on the step_runs UPDATE inside the transaction, after runs has already been updated.
    await db.execute(sql`
      create or replace function test_fail_step_scrub() returns trigger as $$
      begin
        raise exception 'simulated scrub failure';
      end;
      $$ language plpgsql;
    `);
    await db.execute(sql`create trigger test_fail_step_scrub_trg before update on step_runs for each row execute function test_fail_step_scrub()`);
    try {
      await expect(purgeRetiredSecrets(db, key, { now })).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger if exists test_fail_step_scrub_trg on step_runs`);
      await db.execute(sql`drop function if exists test_fail_step_scrub()`);
    }

    // Both the retired_secrets row and the run row rolled back cleanly.
    expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.id, retired.id))).toHaveLength(1);
    const [afterRun] = await db.select().from(runs).where(eq(runs.id, r!.id));
    expect(afterRun!.error).toBe(val);
    // Clean up so later tests in this shared database do not pick up the rolled-back row.
    await db.delete(retiredSecrets).where(eq(retiredSecrets.id, retired.id));
  });

  it("paginates all history tables across multiple bounded batches", async () => {
    for (const bad of [0, -1, 1.5]) {
      await expect(purgeRetiredSecrets(db, key, { batchSize: bad })).rejects.toThrow(/batchSize/);
    }

    const now = new Date("2026-11-19T12:00:00Z");
    const ws = await makeWorkspace();
    const val = `paged-sec-${randomBytes(4).toString("hex")}`;
    await seedRetired(ws.userId, "paged", val, new Date(now.getTime() - 95 * DAY_MS));

    const [res] = await db.insert(resources).values({ userId: ws.userId, name: "Paged Room" }).returning();
    const runIds: string[] = [];
    const stepIds: string[] = [];
    const deliveryIds: string[] = [];
    const requestIds: string[] = [];
    const bookingIds: string[] = [];
    const paymentIds: string[] = [];

    for (let i = 0; i < 5; i++) {
      const [r] = await db
        .insert(runs)
        .values({ workflowVersionId: ws.versionId, state: "failed", triggerPayload: { idx: i, leak: val }, error: `err-${i}-${val}` })
        .returning();
      runIds.push(r!.id);
      const [s] = await db
        .insert(stepRuns)
        .values({ runId: r!.id, stepId: "s", attempt: 1, state: "failed", input: { leak: val }, output: { leak: val }, error: `step-${i}-${val}` })
        .returning();
      stepIds.push(s!.id);
      const [d] = await db
        .insert(deliveries)
        .values({ userId: ws.userId, runId: r!.id, stepId: "d", provider: "slack", reference: `REF-${i}-${val}`, payload: { text: val }, state: "failed", lastError: val, result: { msg: val } })
        .returning();
      deliveryIds.push(d!.id);
      const [req] = await db
        .insert(requests)
        .values({ userId: ws.userId, workflowId: ws.workflowId, runId: r!.id, reference: `REQ-PG-${seq}-${i}`, submissionKey: randomUUID(), subject: `subj-${i}-${val}` })
        .returning();
      requestIds.push(req!.id);
      const startDay = i + 1;
      const [bk] = await db
        .insert(bookings)
        .values({
          userId: ws.userId,
          test: false,
          reference: `BK-PG-${seq}-${i}`,
          resourceId: res!.id,
          during: sql`tstzrange(now() + (${startDay} || ' days')::interval, now() + (${startDay} || ' days')::interval + interval '1 hour')` as unknown as string,
          timezone: "UTC",
          workflowId: ws.workflowId,
          runId: r!.id,
        })
        .returning();
      bookingIds.push(bk!.id);
      await db.insert(calendarEvents).values({ bookingId: bk!.id, userId: ws.userId, title: `Title ${i} ${val}`, description: `Desc ${i} ${val}` });
      const [pay] = await db
        .insert(payments)
        .values({ userId: ws.userId, workflowId: ws.workflowId, runId: r!.id, stepId: "pay", reference: `PAY-${i}-${val}`, amountCentavos: 1000, livemode: false, providerSessionId: `cs_pg_${seq}_${i}`, url: "https://pay.example/pg" })
        .returning();
      paymentIds.push(pay!.id);
    }

    const loggedQueries: { query: string; params: unknown[] }[] = [];
    const loggedDb = drizzle(pool, {
      schema,
      logger: { logQuery: (query, params) => loggedQueries.push({ query, params }) },
    });

    const summary = await purgeRetiredSecrets(loggedDb, key, { now, batchSize: 2 });
    expect(summary).toEqual({ workspaces: 1, retiredDeleted: 1, rowsScrubbed: 30 });
    expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, ws.userId))).toEqual([]);

    // Verify each of the 6 history tables ran 3 keyset-paginated batches (2 + 2 + 1 = 5 rows).
    for (const table of ['"runs"', '"step_runs"', '"deliveries"', '"requests"', '"calendar_events"', '"payments"']) {
      const batchScans = loggedQueries.filter(
        (q) => q.query.startsWith("select ") && q.query.includes(`from ${table}`) && q.query.includes("order by") && q.query.includes("limit") && q.params.includes(2),
      );
      expect(batchScans.length, `expected 3 paginated batches for ${table}`).toBe(3);
    }

    const allStored = [
      ...(await db.select().from(runs).where(sql`${runs.id} = any(${sql.raw(`ARRAY[${runIds.map((id) => `'${id}'::uuid`).join(",")}]`)})`)),
      ...(await db.select().from(stepRuns).where(sql`${stepRuns.id} = any(${sql.raw(`ARRAY[${stepIds.map((id) => `'${id}'::uuid`).join(",")}]`)})`)),
      ...(await db.select().from(deliveries).where(sql`${deliveries.id} = any(${sql.raw(`ARRAY[${deliveryIds.map((id) => `'${id}'::uuid`).join(",")}]`)})`)),
      ...(await db.select().from(requests).where(sql`${requests.id} = any(${sql.raw(`ARRAY[${requestIds.map((id) => `'${id}'::uuid`).join(",")}]`)})`)),
      ...(await db.select().from(calendarEvents).where(sql`${calendarEvents.bookingId} = any(${sql.raw(`ARRAY[${bookingIds.map((id) => `'${id}'::uuid`).join(",")}]`)})`)),
      ...(await db.select().from(payments).where(sql`${payments.id} = any(${sql.raw(`ARRAY[${paymentIds.map((id) => `'${id}'::uuid`).join(",")}]`)})`)),
    ];
    expect(allStored).toHaveLength(30);
    expect(JSON.stringify(allStored)).not.toContain(val);
    expect(JSON.stringify(allStored)).toContain("[secret]");
  });

  it("writes only modified columns and preserves concurrent updates to untouched columns under FOR UPDATE", async () => {
    const now = new Date("2026-11-19T12:00:00Z");
    const ws = await makeWorkspace();
    const val = `col-sec-${randomBytes(4).toString("hex")}`;
    await seedRetired(ws.userId, "colonly", val, new Date(now.getTime() - 100 * DAY_MS));

    // Only error contains the secret; trigger_payload is clean and must not appear in UPDATE ... SET.
    const [r] = await db
      .insert(runs)
      .values({ workflowVersionId: ws.versionId, state: "failed", triggerPayload: { clean: "v1" }, error: `boom ${val}` })
      .returning();

    // A Postgres BEFORE UPDATE OF trigger_payload trigger fires only if trigger_payload is named in UPDATE ... SET.
    await db.execute(sql`
      create or replace function test_forbid_payload_write() returns trigger as $$
      begin
        raise exception 'trigger_payload must not be written when unchanged';
      end;
      $$ language plpgsql;
    `);
    await db.execute(sql`create trigger test_forbid_payload_write_trg before update of trigger_payload on runs for each row execute function test_forbid_payload_write()`);

    try {
      const summary = await purgeRetiredSecrets(db, key, { now });
      expect(summary).toEqual({ workspaces: 1, retiredDeleted: 1, rowsScrubbed: 1 });
    } finally {
      await db.execute(sql`drop trigger if exists test_forbid_payload_write_trg on runs`);
      await db.execute(sql`drop function if exists test_forbid_payload_write()`);
    }

    const [after1] = await db.select().from(runs).where(eq(runs.id, r!.id));
    expect(after1!.error).toBe("boom [secret]");
    expect(after1!.triggerPayload).toEqual({ clean: "v1" });

    // Now prove FOR UPDATE waits for a concurrent row update and re-computes on the locked row values.
    const val2 = `lock-sec-${randomBytes(4).toString("hex")}`;
    await seedRetired(ws.userId, "locktest", val2, new Date(now.getTime() - 100 * DAY_MS));
    const [r2] = await db
      .insert(runs)
      .values({ workflowVersionId: ws.versionId, state: "failed", triggerPayload: { note: "before" }, error: `fail ${val2}` })
      .returning();

    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("UPDATE runs SET trigger_payload = $1 WHERE id = $2", [JSON.stringify({ note: "concurrent" }), r2!.id]);

      const purgePromise = purgeRetiredSecrets(db, key, { now });
      // Wait until purgeRetiredSecrets is actually waiting on the row lock held by locker.
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const res = await db.execute<{ cnt: string }>(sql`
          select count(*)::text as cnt
          from pg_stat_activity
          where wait_event_type = 'Lock' and wait_event = 'transactionid'
        `);
        if (Number(res.rows[0]?.cnt ?? 0) > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);

      await locker.query("COMMIT");
      const summary2 = await purgePromise;
      expect(summary2).toEqual({ workspaces: 1, retiredDeleted: 1, rowsScrubbed: 1 });
    } finally {
      await locker.query("ROLLBACK").catch(() => {});
      locker.release();
    }

    const [after2] = await db.select().from(runs).where(eq(runs.id, r2!.id));
    expect(after2!.triggerPayload).toEqual({ note: "concurrent" });
    expect(after2!.error).toBe("fail [secret]");
  });

  it("skips a workspace with an in-flight running run or sending delivery and purges it once work completes", async () => {
    const now = new Date("2026-11-19T12:00:00Z");
    const wsRun = await makeWorkspace();
    const wsDel = await makeWorkspace();
    const wsIdle = await makeWorkspace();

    const runVal = `active-run-${randomBytes(4).toString("hex")}`;
    const delVal = `active-del-${randomBytes(4).toString("hex")}`;
    const idleVal = `idle-ws-${randomBytes(4).toString("hex")}`;

    const retiredRun = await seedRetired(wsRun.userId, "k", runVal, new Date(now.getTime() - 100 * DAY_MS));
    const retiredDel = await seedRetired(wsDel.userId, "k", delVal, new Date(now.getTime() - 100 * DAY_MS));
    await seedRetired(wsIdle.userId, "k", idleVal, new Date(now.getTime() - 100 * DAY_MS));

    const [activeRun] = await db
      .insert(runs)
      .values({ workflowVersionId: wsRun.versionId, state: "running", triggerPayload: { v: runVal }, error: runVal })
      .returning();
    const [delRun] = await db
      .insert(runs)
      .values({ workflowVersionId: wsDel.versionId, state: "succeeded", triggerPayload: { v: delVal } })
      .returning();
    const [activeDel] = await db
      .insert(deliveries)
      .values({ userId: wsDel.userId, runId: delRun!.id, stepId: "send", provider: "slack", reference: `REF-${delVal}`, payload: { text: delVal }, state: "sending", lastError: delVal })
      .returning();
    const [idleRun] = await db
      .insert(runs)
      .values({ workflowVersionId: wsIdle.versionId, state: "failed", triggerPayload: { v: idleVal }, error: idleVal })
      .returning();

    // First sweep: skips wsRun and wsDel, purges wsIdle cleanly.
    const first = await purgeRetiredSecrets(db, key, { now });
    expect(first).toEqual({ workspaces: 1, retiredDeleted: 1, rowsScrubbed: 1 });

    expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.id, retiredRun.id))).toHaveLength(1);
    expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.id, retiredDel.id))).toHaveLength(1);
    expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, wsIdle.userId))).toEqual([]);
    expect((await db.select().from(runs).where(eq(runs.id, idleRun!.id)))[0]!.error).toBe("[secret]");

    // Finish the active run and active delivery, then sweep again.
    await db.update(runs).set({ state: "failed" }).where(eq(runs.id, activeRun!.id));
    await db.update(deliveries).set({ state: "failed" }).where(eq(deliveries.id, activeDel!.id));

    const second = await purgeRetiredSecrets(db, key, { now });
    expect(second).toEqual({ workspaces: 2, retiredDeleted: 2, rowsScrubbed: 3 });

    expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, wsRun.userId))).toEqual([]);
    expect(await db.select().from(retiredSecrets).where(eq(retiredSecrets.userId, wsDel.userId))).toEqual([]);
    expect((await db.select().from(runs).where(eq(runs.id, activeRun!.id)))[0]!.error).toBe("[secret]");
    expect((await db.select().from(deliveries).where(eq(deliveries.id, activeDel!.id)))[0]!.lastError).toBe("[secret]");
  });
});
