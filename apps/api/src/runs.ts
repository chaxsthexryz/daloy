import { runs, stepRuns, workflows, workflowVersions, type Db } from "@daloy/db";
import { Controller, Get, Inject, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { CurrentUser, DB, ZodPipe, type SessionUser } from "./http";

/** Run history, read only. The full history view with masking and timing is phase 6. */
@Controller("runs")
@UseGuards(SessionGuard)
export class RunsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  list(@CurrentUser() user: SessionUser, @Query("workflowId", new ZodPipe(z.uuid().optional())) workflowId?: string) {
    return this.owned()
      .where(and(eq(workflows.userId, user.id), workflowId ? eq(workflows.id, workflowId) : undefined))
      .orderBy(desc(runs.createdAt))
      .limit(50);
  }

  @Get(":id")
  async get(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    const [run] = await this.owned().where(and(eq(workflows.userId, user.id), eq(runs.id, id)));
    if (!run) throw new NotFoundException();
    const steps = await this.db.select().from(stepRuns).where(eq(stepRuns.runId, id)).orderBy(asc(stepRuns.createdAt), asc(stepRuns.attempt));
    return { ...run, steps };
  }

  /** Runs joined to their workflow, so every query can filter on the owner. Lease columns stay internal. */
  private owned() {
    const { id, state, triggerPayload, error, nextAttemptAt, createdAt, finishedAt } = runs;
    return this.db
      .select({ id, state, triggerPayload, error, nextAttemptAt, createdAt, finishedAt, workflowId: workflows.id, version: workflowVersions.version })
      .from(runs)
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .$dynamic();
  }
}
