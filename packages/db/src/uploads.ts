import type { FileKind } from "@daloy/engine";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { uploads } from "./schema";

type AnyDb = NodePgDatabase<Record<string, unknown>>;

/** How long a form's files stay in the database. A Drive step saves them well before that. */
export const UPLOAD_RETENTION_MS = 7 * 24 * 3600_000;

export type NewUpload = { id: string; field: string; name: string; type: FileKind; data: Buffer };

/** Stores a submission's files. Pass the transaction that inserts the run, so the run and its files commit together. */
export async function saveUploads(tx: AnyDb, { userId, runId, files }: { userId: string; runId: string; files: NewUpload[] }) {
  if (files.length === 0) return;
  await tx.insert(uploads).values(files.map((f) => ({ id: f.id, userId, runId, field: f.field, name: f.name, type: f.type, size: f.data.length, data: f.data })));
}

/** One file, only when the workspace, the run and the file id all match. Null when it is gone or belongs elsewhere. */
export async function readUpload(db: AnyDb, { userId, runId, id }: { userId: string; runId: string; id: string }) {
  const [row] = await db
    .select({ name: uploads.name, type: uploads.type, size: uploads.size, data: uploads.data })
    .from(uploads)
    .where(and(eq(uploads.id, id), eq(uploads.runId, runId), eq(uploads.userId, userId)));
  return row ?? null;
}

/** Deletes the oldest files past retention, at most limit per call. Returns how many went. */
export async function purgeUploads(db: AnyDb, retentionMs = UPLOAD_RETENTION_MS, limit = 200): Promise<number> {
  const old = db
    .select({ id: uploads.id })
    .from(uploads)
    .where(sql`${uploads.createdAt} < now() - make_interval(secs => ${retentionMs / 1000})`)
    .orderBy(uploads.createdAt)
    .limit(limit);
  const gone = await db.delete(uploads).where(inArray(uploads.id, old)).returning({ id: uploads.id });
  return gone.length;
}
