import { isDeepStrictEqual } from "node:util";
import { KNOWLEDGE_KINDS, type KnowledgeEntry } from "@daloy/engine";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./index";
import { knowledgeEntries, knowledgeVersions } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const kindOrder = (k: string) => KNOWLEDGE_KINDS.indexOf(k as never);

/** The draft rows in the order a published copy keeps them: by kind, then oldest first. */
export async function draftEntries(db: Db | Tx, userId: string): Promise<KnowledgeEntry[]> {
  const rows = await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.userId, userId)).orderBy(asc(knowledgeEntries.createdAt), asc(knowledgeEntries.id));
  return rows
    .map((r) => ({ id: r.id, kind: r.kind as KnowledgeEntry["kind"], title: r.title, body: r.body, fields: r.fields as KnowledgeEntry["fields"] }))
    .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind));
}

/** The version in use: the highest published one, or null before the first publish. Answers read this, never the drafts. */
export async function readKnowledge(db: Db | Tx, userId: string) {
  const [row] = await db.select().from(knowledgeVersions).where(eq(knowledgeVersions.userId, userId)).orderBy(desc(knowledgeVersions.version)).limit(1);
  return row ?? null;
}

export const knowledgeChanged = (drafts: KnowledgeEntry[], published: { entries: KnowledgeEntry[] } | null) => !isDeepStrictEqual(drafts, published?.entries ?? []);

/** Null when there is nothing to publish (no entries, or no change since the version in use). Two publishes at once give the second a unique violation. */
export async function publishKnowledge(db: Db, userId: string) {
  return db.transaction(async (tx) => {
    // Serialises one workspace's publishes, so the version number and the "unchanged" check cannot race.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"knowledge:" + userId}, 0))`);
    const drafts = await draftEntries(tx, userId);
    const current = await readKnowledge(tx, userId);
    if (!drafts.length || !knowledgeChanged(drafts, current)) return null;
    const [row] = await tx.insert(knowledgeVersions).values({ userId, version: (current?.version ?? 0) + 1, entries: drafts }).returning();
    return row!;
  });
}
