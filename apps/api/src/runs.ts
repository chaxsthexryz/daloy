import { runs, stepRuns, workflows, workflowVersions, type Db } from "@daloy/db";
import { Controller, Get, Inject, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { CurrentUser, DB, ZodPipe, type SessionUser } from "./http";
import { maskSecrets } from "./mask";

const testFlag = new ZodPipe(z.enum(["true", "false"]).optional());

/**
 * Run history, read only. Every payload, step input and step output passes through maskSecrets on the way out,
 * on top of the worker's redaction at write time.
 */
@Controller("runs")
@UseGuards(SessionGuard)
export class RunsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The latest 50 runs, newest first. test=true lists builder test runs only, test=false the others. */
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query("workflowId", new ZodPipe(z.uuid().optional())) workflowId?: string,
    @Query("test", testFlag) test?: "true" | "false",
  ) {
    const rows = await this.owned()
      .where(and(eq(workflows.userId, user.id), workflowId ? eq(workflows.id, workflowId) : undefined, test ? eq(runs.test, test === "true") : undefined))
      .orderBy(desc(runs.createdAt))
      .limit(50);
    return rows.map((r) => ({ ...r, triggerPayload: maskSecrets(r.triggerPayload) }));
  }

  @Get(":id")
  async get(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    const [run] = await this.owned().where(and(eq(workflows.userId, user.id), eq(runs.id, id)));
    if (!run) throw new NotFoundException();
    const steps = await this.db.select().from(stepRuns).where(eq(stepRuns.runId, id)).orderBy(asc(stepRuns.createdAt), asc(stepRuns.attempt));
    return {
      ...run,
      triggerPayload: maskSecrets(run.triggerPayload),
      steps: steps.map((s) => ({ ...s, input: maskSecrets(s.input), output: maskSecrets(s.output) })),
    };
  }

  /** Runs joined to their workflow, so every query can filter on the owner. Lease columns stay internal. */
  private owned() {
    const { id, state, triggerPayload, test, live, error, nextAttemptAt, createdAt, finishedAt } = runs;
    return this.db
      .select({ id, state, triggerPayload, test, live, error, nextAttemptAt, createdAt, finishedAt, workflowId: workflows.id, version: workflowVersions.version })
      .from(runs)
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .$dynamic();
  }
}
