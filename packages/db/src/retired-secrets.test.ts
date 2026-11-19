import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db } from "./index";
import { DEFAULT_RETIRED_SECRET_MAX_AGE_DAYS, purgeRetiredSecrets, retiredSecretMaxAgeDays } from "./retired-secrets";
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
  });
});
