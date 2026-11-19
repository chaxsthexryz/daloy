import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { decryptSecret, redactSecrets, secretForms } from "./crypto";
import type { Db } from "./index";
import { calendarEvents, connections, deliveries, emailSources, mailSenders, payments, requests, retiredSecrets, runs, stepRuns, workflows, workflowVersions } from "./schema";

export const DEFAULT_RETIRED_SECRET_MAX_AGE_DAYS = 90;
const DAY_MS = 86_400_000;

export type PurgeRetiredSecretsOptions = {
  maxAgeDays?: number;
  now?: Date;
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

async function scrubWorkspaceHistory(tx: Tx, userId: string, forms: string[]): Promise<number> {
  if (forms.length === 0) return 0;
  let scrubbed = 0;

  const runRows = await tx
    .select({ id: runs.id, triggerPayload: runs.triggerPayload, error: runs.error })
    .from(runs)
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(eq(workflows.userId, userId));
  for (const row of runRows) {
    const payload = scrubUnknown(row.triggerPayload, forms);
    const error = scrubNullableString(row.error, forms);
    if (payload.changed || error.changed) {
      await tx.update(runs).set({ triggerPayload: payload.value, error: error.value }).where(eq(runs.id, row.id));
      scrubbed++;
    }
  }

  const stepRows = await tx
    .select({ id: stepRuns.id, input: stepRuns.input, output: stepRuns.output, error: stepRuns.error })
    .from(stepRuns)
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(eq(workflows.userId, userId));
  for (const row of stepRows) {
    const input = scrubUnknown(row.input, forms);
    const output = scrubUnknown(row.output, forms);
    const error = scrubNullableString(row.error, forms);
    if (input.changed || output.changed || error.changed) {
      await tx.update(stepRuns).set({ input: input.value, output: output.value, error: error.value }).where(eq(stepRuns.id, row.id));
      scrubbed++;
    }
  }

  const deliveryRows = await tx
    .select({ id: deliveries.id, payload: deliveries.payload, result: deliveries.result, lastError: deliveries.lastError, reference: deliveries.reference })
    .from(deliveries)
    .where(eq(deliveries.userId, userId));
  for (const row of deliveryRows) {
    const payload = scrubUnknown(row.payload, forms);
    const result = scrubUnknown(row.result, forms);
    const lastError = scrubNullableString(row.lastError, forms);
    const reference = scrubString(row.reference, forms);
    if (payload.changed || result.changed || lastError.changed || reference.changed) {
      await tx
        .update(deliveries)
        .set({
          payload: payload.value as typeof deliveries.$inferInsert.payload,
          result: result.value as typeof deliveries.$inferInsert.result,
          lastError: lastError.value,
          reference: reference.value,
        })
        .where(eq(deliveries.id, row.id));
      scrubbed++;
    }
  }

  const requestRows = await tx.select({ id: requests.id, subject: requests.subject }).from(requests).where(eq(requests.userId, userId));
  for (const row of requestRows) {
    const subject = scrubString(row.subject, forms);
    if (subject.changed) {
      await tx.update(requests).set({ subject: subject.value }).where(eq(requests.id, row.id));
      scrubbed++;
    }
  }

  const connRows = await tx
    .select({ provider: connections.provider, lastError: connections.lastError })
    .from(connections)
    .where(and(eq(connections.userId, userId), isNotNull(connections.lastError)));
  for (const row of connRows) {
    const lastError = scrubNullableString(row.lastError, forms);
    if (lastError.changed) {
      await tx.update(connections).set({ lastError: lastError.value }).where(and(eq(connections.userId, userId), eq(connections.provider, row.provider)));
      scrubbed++;
    }
  }

  const sourceRows = await tx
    .select({ id: emailSources.id, lastError: emailSources.lastError })
    .from(emailSources)
    .innerJoin(workflows, eq(workflows.id, emailSources.workflowId))
    .where(and(eq(workflows.userId, userId), isNotNull(emailSources.lastError)));
  for (const row of sourceRows) {
    const lastError = scrubNullableString(row.lastError, forms);
    if (lastError.changed) {
      await tx.update(emailSources).set({ lastError: lastError.value }).where(eq(emailSources.id, row.id));
      scrubbed++;
    }
  }

  const senderRows = await tx
    .select({ userId: mailSenders.userId, lastError: mailSenders.lastError })
    .from(mailSenders)
    .where(and(eq(mailSenders.userId, userId), isNotNull(mailSenders.lastError)));
  for (const row of senderRows) {
    const lastError = scrubNullableString(row.lastError, forms);
    if (lastError.changed) {
      await tx.update(mailSenders).set({ lastError: lastError.value }).where(eq(mailSenders.userId, userId));
      scrubbed++;
    }
  }

  const calendarRows = await tx
    .select({ bookingId: calendarEvents.bookingId, title: calendarEvents.title, description: calendarEvents.description })
    .from(calendarEvents)
    .where(eq(calendarEvents.userId, userId));
  for (const row of calendarRows) {
    const title = scrubString(row.title, forms);
    const description = scrubString(row.description, forms);
    if (title.changed || description.changed) {
      await tx.update(calendarEvents).set({ title: title.value, description: description.value }).where(eq(calendarEvents.bookingId, row.bookingId));
      scrubbed++;
    }
  }

  const paymentRows = await tx.select({ id: payments.id, reference: payments.reference }).from(payments).where(eq(payments.userId, userId));
  for (const row of paymentRows) {
    const reference = scrubString(row.reference, forms);
    if (reference.changed) {
      await tx.update(payments).set({ reference: reference.value }).where(eq(payments.id, row.id));
      scrubbed++;
    }
  }

  return scrubbed;
}

/**
 * Permanently scrubs expired retired secret values (at or past maxAgeDays, default 90) from a workspace's stored
 * history and state tables, then deletes only those exact retired_secrets rows in the same transaction (decision 0067).
 */
export async function purgeRetiredSecrets(db: Db, secretsKey: Buffer, opts: PurgeRetiredSecretsOptions = {}): Promise<PurgeRetiredSecretsResult> {
  const maxAgeDays = opts.maxAgeDays ?? retiredSecretMaxAgeDays();
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) throw new Error("maxAgeDays must be a positive integer");
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

      const scrubbed = await scrubWorkspaceHistory(tx, userId, secretForms(values));
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
