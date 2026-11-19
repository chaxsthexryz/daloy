import { and, asc, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { decryptSecret, redactSecrets, secretForms } from "./crypto";
import type { Db } from "./index";
import { calendarEvents, connections, deliveries, emailSources, mailSenders, payments, requests, retiredSecrets, runs, stepRuns, workflows, workflowVersions } from "./schema";

export const DEFAULT_RETIRED_SECRET_MAX_AGE_DAYS = 90;
export const DEFAULT_RETIRED_SECRET_BATCH_SIZE = 200;
const DAY_MS = 86_400_000;

export type PurgeRetiredSecretsOptions = {
  maxAgeDays?: number;
  now?: Date;
  batchSize?: number;
};

export type PurgeRetiredSecretsResult = {
  workspaces: number;
  retiredDeleted: number;
  rowsScrubbed: number;
};

/** Parses RETIRED_SECRETS_MAX_AGE_DAYS as a positive integer, defaulting to 90 days when unset or blank. */
export function retiredSecretMaxAgeDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RETIRED_SECRETS_MAX_AGE_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_RETIRED_SECRET_MAX_AGE_DAYS;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("RETIRED_SECRETS_MAX_AGE_DAYS must be a positive integer");
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1) throw new Error("RETIRED_SECRETS_MAX_AGE_DAYS must be a positive integer");
  return days;
}

function scrubString(value: string, forms: string[]): { value: string; changed: boolean } {
  const next = redactSecrets(value, forms) as string;
  return { value: next, changed: next !== value };
}

function scrubNullableString(value: string | null, forms: string[]): { value: string | null; changed: boolean } {
  if (value === null) return { value: null, changed: false };
  return scrubString(value, forms);
}

function scrubUnknown(value: unknown, forms: string[]): { value: unknown; changed: boolean } {
  if (forms.length === 0) return { value, changed: false };
  if (typeof value === "string") return scrubString(value, forms);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = scrubUnknown(item, forms);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { value: next, changed: true } : { value, changed: false };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const entries = Object.entries(value).map(([k, v]) => {
      const rk = scrubString(k, forms);
      const rv = scrubUnknown(v, forms);
      if (rk.changed || rv.changed) changed = true;
      return [rk.value, rv.value] as const;
    });
    return changed ? { value: Object.fromEntries(entries), changed: true } : { value, changed: false };
  }
  return { value, changed: false };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function hasInFlightWork(tx: Tx, userId: string): Promise<boolean> {
  const [activeRun] = await tx
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(and(eq(workflows.userId, userId), eq(runs.state, "running")))
    .limit(1);
  if (activeRun) return true;

  const [activeDelivery] = await tx
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(and(eq(deliveries.userId, userId), eq(deliveries.state, "sending")))
    .limit(1);
  return activeDelivery !== undefined;
}

async function scrubWorkspaceHistory(tx: Tx, userId: string, forms: string[], batchSize: number): Promise<number> {
  if (forms.length === 0) return 0;
  let scrubbed = 0;

  for (let lastId: string | undefined; ; ) {
    const batch = await tx
      .select({ id: runs.id, triggerPayload: runs.triggerPayload, error: runs.error })
      .from(runs)
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(lastId ? and(eq(workflows.userId, userId), gt(runs.id, lastId)) : eq(workflows.userId, userId))
      .orderBy(asc(runs.id))
      .limit(batchSize);
    if (batch.length === 0) break;
    for (const row of batch) {
      if (!scrubUnknown(row.triggerPayload, forms).changed && !scrubNullableString(row.error, forms).changed) continue;
      const [locked] = await tx
        .select({ triggerPayload: runs.triggerPayload, error: runs.error })
        .from(runs)
        .where(eq(runs.id, row.id))
        .for("update");
      if (!locked) continue;
      const payload = scrubUnknown(locked.triggerPayload, forms);
      const error = scrubNullableString(locked.error, forms);
      const patch: Partial<typeof runs.$inferInsert> = {};
      if (payload.changed) patch.triggerPayload = payload.value;
      if (error.changed) patch.error = error.value;
      if (Object.keys(patch).length > 0) {
        await tx.update(runs).set(patch).where(eq(runs.id, row.id));
        scrubbed++;
      }
    }
    if (batch.length < batchSize) break;
    lastId = batch[batch.length - 1]!.id;
  }

  for (let lastId: string | undefined; ; ) {
    const batch = await tx
      .select({ id: stepRuns.id, input: stepRuns.input, output: stepRuns.output, error: stepRuns.error })
      .from(stepRuns)
      .innerJoin(runs, eq(runs.id, stepRuns.runId))
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(lastId ? and(eq(workflows.userId, userId), gt(stepRuns.id, lastId)) : eq(workflows.userId, userId))
      .orderBy(asc(stepRuns.id))
      .limit(batchSize);
    if (batch.length === 0) break;
    for (const row of batch) {
      if (
        !scrubUnknown(row.input, forms).changed &&
        !scrubUnknown(row.output, forms).changed &&
        !scrubNullableString(row.error, forms).changed
      ) {
        continue;
      }
      const [locked] = await tx
        .select({ input: stepRuns.input, output: stepRuns.output, error: stepRuns.error })
        .from(stepRuns)
        .where(eq(stepRuns.id, row.id))
        .for("update");
      if (!locked) continue;
      const input = scrubUnknown(locked.input, forms);
      const output = scrubUnknown(locked.output, forms);
      const error = scrubNullableString(locked.error, forms);
      const patch: Partial<typeof stepRuns.$inferInsert> = {};
      if (input.changed) patch.input = input.value;
      if (output.changed) patch.output = output.value;
      if (error.changed) patch.error = error.value;
      if (Object.keys(patch).length > 0) {
        await tx.update(stepRuns).set(patch).where(eq(stepRuns.id, row.id));
        scrubbed++;
      }
    }
    if (batch.length < batchSize) break;
    lastId = batch[batch.length - 1]!.id;
  }

  for (let lastId: string | undefined; ; ) {
    const batch = await tx
      .select({ id: deliveries.id, payload: deliveries.payload, result: deliveries.result, lastError: deliveries.lastError, reference: deliveries.reference })
      .from(deliveries)
      .where(lastId ? and(eq(deliveries.userId, userId), gt(deliveries.id, lastId)) : eq(deliveries.userId, userId))
      .orderBy(asc(deliveries.id))
      .limit(batchSize);
    if (batch.length === 0) break;
    for (const row of batch) {
      if (
        !scrubUnknown(row.payload, forms).changed &&
        !scrubUnknown(row.result, forms).changed &&
        !scrubNullableString(row.lastError, forms).changed &&
        !scrubString(row.reference, forms).changed
      ) {
        continue;
      }
      const [locked] = await tx
        .select({ payload: deliveries.payload, result: deliveries.result, lastError: deliveries.lastError, reference: deliveries.reference })
        .from(deliveries)
        .where(eq(deliveries.id, row.id))
        .for("update");
      if (!locked) continue;
      const payload = scrubUnknown(locked.payload, forms);
      const result = scrubUnknown(locked.result, forms);
      const lastError = scrubNullableString(locked.lastError, forms);
      const reference = scrubString(locked.reference, forms);
      const patch: Partial<typeof deliveries.$inferInsert> = {};
      if (payload.changed) patch.payload = payload.value as typeof deliveries.$inferInsert.payload;
      if (result.changed) patch.result = result.value as typeof deliveries.$inferInsert.result;
      if (lastError.changed) patch.lastError = lastError.value;
      if (reference.changed) patch.reference = reference.value;
      if (Object.keys(patch).length > 0) {
        await tx.update(deliveries).set(patch).where(eq(deliveries.id, row.id));
        scrubbed++;
      }
    }
    if (batch.length < batchSize) break;
    lastId = batch[batch.length - 1]!.id;
  }

  for (let lastId: string | undefined; ; ) {
    const batch = await tx
      .select({ id: requests.id, subject: requests.subject })
      .from(requests)
      .where(lastId ? and(eq(requests.userId, userId), gt(requests.id, lastId)) : eq(requests.userId, userId))
      .orderBy(asc(requests.id))
      .limit(batchSize);
    if (batch.length === 0) break;
    for (const row of batch) {
      if (!scrubString(row.subject, forms).changed) continue;
      const [locked] = await tx
        .select({ subject: requests.subject })
        .from(requests)
        .where(eq(requests.id, row.id))
        .for("update");
      if (!locked) continue;
      const subject = scrubString(locked.subject, forms);
      if (subject.changed) {
        await tx.update(requests).set({ subject: subject.value }).where(eq(requests.id, row.id));
        scrubbed++;
      }
    }
    if (batch.length < batchSize) break;
    lastId = batch[batch.length - 1]!.id;
  }

  const connRows = await tx
    .select({ provider: connections.provider, lastError: connections.lastError })
    .from(connections)
    .where(and(eq(connections.userId, userId), isNotNull(connections.lastError)));
  for (const row of connRows) {
    if (!scrubNullableString(row.lastError, forms).changed) continue;
    const [locked] = await tx
      .select({ lastError: connections.lastError })
      .from(connections)
      .where(and(eq(connections.userId, userId), eq(connections.provider, row.provider)))
      .for("update");
    if (!locked) continue;
    const lastError = scrubNullableString(locked.lastError, forms);
    if (lastError.changed) {
      await tx.update(connections).set({ lastError: lastError.value }).where(and(eq(connections.userId, userId), eq(connections.provider, row.provider)));
      scrubbed++;
    }
  }

  for (let lastId: string | undefined; ; ) {
    const batch = await tx
      .select({ id: emailSources.id, lastError: emailSources.lastError })
      .from(emailSources)
      .innerJoin(workflows, eq(workflows.id, emailSources.workflowId))
      .where(
        lastId
          ? and(eq(workflows.userId, userId), isNotNull(emailSources.lastError), gt(emailSources.id, lastId))
          : and(eq(workflows.userId, userId), isNotNull(emailSources.lastError)),
      )
      .orderBy(asc(emailSources.id))
      .limit(batchSize);
    if (batch.length === 0) break;
    for (const row of batch) {
      if (!scrubNullableString(row.lastError, forms).changed) continue;
      const [locked] = await tx
        .select({ lastError: emailSources.lastError })
        .from(emailSources)
        .where(eq(emailSources.id, row.id))
        .for("update");
      if (!locked) continue;
      const lastError = scrubNullableString(locked.lastError, forms);
      if (lastError.changed) {
        await tx.update(emailSources).set({ lastError: lastError.value }).where(eq(emailSources.id, row.id));
        scrubbed++;
      }
    }
    if (batch.length < batchSize) break;
    lastId = batch[batch.length - 1]!.id;
  }

  const senderRows = await tx
    .select({ userId: mailSenders.userId, lastError: mailSenders.lastError })
    .from(mailSenders)
    .where(and(eq(mailSenders.userId, userId), isNotNull(mailSenders.lastError)));
  for (const row of senderRows) {
    if (!scrubNullableString(row.lastError, forms).changed) continue;
    const [locked] = await tx
      .select({ lastError: mailSenders.lastError })
      .from(mailSenders)
      .where(eq(mailSenders.userId, userId))
      .for("update");
    if (!locked) continue;
    const lastError = scrubNullableString(locked.lastError, forms);
    if (lastError.changed) {
      await tx.update(mailSenders).set({ lastError: lastError.value }).where(eq(mailSenders.userId, userId));
      scrubbed++;
    }
  }

  for (let lastBookingId: string | undefined; ; ) {
    const batch = await tx
      .select({ bookingId: calendarEvents.bookingId, title: calendarEvents.title, description: calendarEvents.description })
      .from(calendarEvents)
      .where(lastBookingId ? and(eq(calendarEvents.userId, userId), gt(calendarEvents.bookingId, lastBookingId)) : eq(calendarEvents.userId, userId))
      .orderBy(asc(calendarEvents.bookingId))
      .limit(batchSize);
    if (batch.length === 0) break;
    for (const row of batch) {
      if (!scrubString(row.title, forms).changed && !scrubString(row.description, forms).changed) continue;
      const [locked] = await tx
        .select({ title: calendarEvents.title, description: calendarEvents.description })
        .from(calendarEvents)
        .where(eq(calendarEvents.bookingId, row.bookingId))
        .for("update");
      if (!locked) continue;
      const title = scrubString(locked.title, forms);
      const description = scrubString(locked.description, forms);
      const patch: Partial<typeof calendarEvents.$inferInsert> = {};
      if (title.changed) patch.title = title.value;
      if (description.changed) patch.description = description.value;
      if (Object.keys(patch).length > 0) {
        await tx.update(calendarEvents).set(patch).where(eq(calendarEvents.bookingId, row.bookingId));
        scrubbed++;
      }
    }
    if (batch.length < batchSize) break;
    lastBookingId = batch[batch.length - 1]!.bookingId;
  }

  for (let lastId: string | undefined; ; ) {
    const batch = await tx
      .select({ id: payments.id, reference: payments.reference })
      .from(payments)
      .where(lastId ? and(eq(payments.userId, userId), gt(payments.id, lastId)) : eq(payments.userId, userId))
      .orderBy(asc(payments.id))
      .limit(batchSize);
    if (batch.length === 0) break;
    for (const row of batch) {
      if (!scrubString(row.reference, forms).changed) continue;
      const [locked] = await tx
        .select({ reference: payments.reference })
        .from(payments)
        .where(eq(payments.id, row.id))
        .for("update");
      if (!locked) continue;
      const reference = scrubString(locked.reference, forms);
      if (reference.changed) {
        await tx.update(payments).set({ reference: reference.value }).where(eq(payments.id, row.id));
        scrubbed++;
      }
    }
    if (batch.length < batchSize) break;
    lastId = batch[batch.length - 1]!.id;
  }

  return scrubbed;
}

/**
 * Permanently scrubs expired retired secret values (at or past maxAgeDays, default 90) from a workspace's stored
 * history and state tables in bounded keyset batches with row-level locking and column-only updates, then deletes
 * only those exact retired_secrets rows in the same transaction (decision 0067). Workspaces with in-flight runs
 * or deliveries are skipped until the next sweep.
 */
export async function purgeRetiredSecrets(db: Db, secretsKey: Buffer, opts: PurgeRetiredSecretsOptions = {}): Promise<PurgeRetiredSecretsResult> {
  const maxAgeDays = opts.maxAgeDays ?? retiredSecretMaxAgeDays();
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) throw new Error("maxAgeDays must be a positive integer");
  const batchSize = opts.batchSize ?? DEFAULT_RETIRED_SECRET_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive integer");
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - maxAgeDays * DAY_MS);

  const dueWorkspaces = await db
    .selectDistinct({ userId: retiredSecrets.userId })
    .from(retiredSecrets)
    .where(lte(retiredSecrets.retiredAt, cutoff));

  let workspaces = 0;
  let retiredDeleted = 0;
  let rowsScrubbed = 0;

  for (const { userId } of dueWorkspaces) {
    const out = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`retired-purge:${userId}`}, 0))`);
      const expired = await tx
        .select()
        .from(retiredSecrets)
        .where(and(eq(retiredSecrets.userId, userId), lte(retiredSecrets.retiredAt, cutoff)));
      if (expired.length === 0) return { deleted: 0, scrubbed: 0 };

      // Skip workspaces with active runs or deliveries so a live worker cannot write a retired secret after the scan.
      if (await hasInFlightWork(tx, userId)) return { deleted: 0, scrubbed: 0 };

      const values: string[] = [];
      const deletableIds: string[] = [];
      for (const row of expired) {
        try {
          values.push(decryptSecret(secretsKey, userId, row.name, row));
          deletableIds.push(row.id);
        } catch {
          // Skip rows that fail decryption: never delete a retired secret without scrubbing its value first.
          console.error(`retired_secrets purge skipped undecryptable row ${row.id} for workspace ${userId}`);
        }
      }
      if (deletableIds.length === 0) return { deleted: 0, scrubbed: 0 };

      const scrubbed = await scrubWorkspaceHistory(tx, userId, secretForms(values), batchSize);

      // Re-check before deleting so work that started mid-sweep keeps the retired rows until a quiet sweep.
      if (await hasInFlightWork(tx, userId)) return { deleted: 0, scrubbed: 0 };

      const deleted = await tx
        .delete(retiredSecrets)
        .where(and(eq(retiredSecrets.userId, userId), inArray(retiredSecrets.id, deletableIds)))
        .returning({ id: retiredSecrets.id });
      return { deleted: deleted.length, scrubbed };
    });

    if (out.deleted > 0) {
      workspaces++;
      retiredDeleted += out.deleted;
      rowsScrubbed += out.scrubbed;
    }
  }

  return { workspaces, retiredDeleted, rowsScrubbed };
}
