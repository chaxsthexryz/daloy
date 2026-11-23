import { draftEntries, knowledgeChanged, knowledgeEntries, knowledgeVersions, publishKnowledge, readKnowledge, type Db } from "@daloy/db";
import { knowledgeEntryInput, MAX_KNOWLEDGE_ENTRIES } from "@daloy/engine";
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CurrentUser, DB, isUniqueViolation, OPERATE, ZodPipe, type SessionUser } from "./http";

/**
 * The knowledge sheet the concierge answers from (decision 0116). Owner and operator edit draft entries; Publish
 * freezes a numbered copy, and only the latest copy is ever read for an answer.
 */
@Controller("knowledge")
@UseGuards(SessionGuard, Allow(OPERATE))
export class KnowledgeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async read(@CurrentUser() user: SessionUser) {
    const [entries, published, versions] = await Promise.all([
      draftEntries(this.db, user.workspaceId),
      readKnowledge(this.db, user.workspaceId),
      this.db
        .select({ version: knowledgeVersions.version, createdAt: knowledgeVersions.createdAt })
        .from(knowledgeVersions)
        .where(eq(knowledgeVersions.userId, user.workspaceId))
        .orderBy(desc(knowledgeVersions.version))
        .limit(20),
    ]);
    return {
      entries,
      published: published && { version: published.version, createdAt: published.createdAt, entryCount: published.entries.length },
      // True when the drafts differ from the version in use, so the page can say there is something to publish.
      changed: !!entries.length && knowledgeChanged(entries, published),
      versions,
    };
  }

  /** A published copy exactly as saved, for the owner to see what a given version said. */
  @Get("versions/:version")
  async version(@CurrentUser() user: SessionUser, @Param("version", ParseIntPipe) version: number) {
    const [row] = await this.db.select().from(knowledgeVersions).where(and(eq(knowledgeVersions.userId, user.workspaceId), eq(knowledgeVersions.version, version)));
    if (!row) throw new NotFoundException();
    return { version: row.version, createdAt: row.createdAt, entries: row.entries };
  }

  @Post("entries")
  async create(@CurrentUser() user: SessionUser, @Body(new ZodPipe(knowledgeEntryInput)) body: z.output<typeof knowledgeEntryInput>) {
    // shortcut: two creates at once can pass this check together and overshoot the cap by one, which costs nothing.
    const [{ n } = { n: 0 }] = await this.db.select({ n: count() }).from(knowledgeEntries).where(eq(knowledgeEntries.userId, user.workspaceId));
    if (n >= MAX_KNOWLEDGE_ENTRIES) throw new BadRequestException(`A knowledge sheet holds at most ${MAX_KNOWLEDGE_ENTRIES} entries`);
    const [row] = await this.db.insert(knowledgeEntries).values({ userId: user.workspaceId, ...body }).returning({ id: knowledgeEntries.id });
    return { id: row!.id, ...body };
  }

  @Patch("entries/:id")
  async update(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string, @Body(new ZodPipe(knowledgeEntryInput)) body: z.output<typeof knowledgeEntryInput>) {
    const [row] = await this.db
      .update(knowledgeEntries)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.userId, user.workspaceId)))
      .returning({ id: knowledgeEntries.id });
    if (!row) throw new NotFoundException();
    return { id, ...body };
  }

  /** Removes the draft. Published versions keep their copy, so an answer already cited it stays explainable. */
  @Delete("entries/:id")
  @HttpCode(204)
  async remove(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    const [row] = await this.db.delete(knowledgeEntries).where(and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.userId, user.workspaceId))).returning({ id: knowledgeEntries.id });
    if (!row) throw new NotFoundException();
  }

  @Post("publish")
  async publish(@CurrentUser() user: SessionUser) {
    let row;
    try {
      row = await publishKnowledge(this.db, user.workspaceId);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("Another publish ran at the same time. Reload and try again.");
      throw err;
    }
    if (!row) throw new BadRequestException("Nothing to publish: add an entry or change one first");
    return { version: row.version, createdAt: row.createdAt, entryCount: row.entries.length };
  }
}
