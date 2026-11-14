import { redactSecrets, runs, secretForms, secretValuesToHide, stepRuns, workflows, workflowVersions, type Db } from "@daloy/db";
import { Controller, Get, Inject, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, ZodPipe, type ApiConfig, type SessionUser, OPERATE } from "./http";
import { maskSecrets } from "./mask";

const testFlag = new ZodPipe(z.enum(["true", "false"]).optional());

/**
 * Run history, read only. On the way out, every payload, step input, output and error first has every form of the
 * workspace's current and retired secret values replaced (decision 0025), so a row written before a redaction fix, or
 * before a rotation, still hides them. maskSecrets then hides values under secret-looking keys.
 */
@Controller("runs")
@UseGuards(SessionGuard, Allow(OPERATE))
export class RunsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  private async hide(workspaceId: string) {
    const forms = secretForms(await secretValuesToHide(this.db, this.config.secretsKey, workspaceId));
    return (v: unknown) => maskSecrets(redactSecrets(v, forms));
  }

  /** The latest 50 runs, newest first. test=true lists builder test runs only, test=false the others. */
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query("workflowId", new ZodPipe(z.uuid().optional())) workflowId?: string,
    @Query("test", testFlag) test?: "true" | "false",
  ) {
    const rows = await this.owned()
      .where(and(eq(workflows.userId, user.workspaceId), workflowId ? eq(workflows.id, workflowId) : undefined, test ? eq(runs.test, test === "true") : undefined))
      .orderBy(desc(runs.createdAt))
      .limit(50);
    const hide = await this.hide(user.workspaceId);
    return rows.map((r) => ({ ...r, triggerPayload: hide(r.triggerPayload), error: hide(r.error) as string | null }));
  }

  @Get(":id")
  async get(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    const [run] = await this.owned().where(and(eq(workflows.userId, user.workspaceId), eq(runs.id, id)));
    if (!run) throw new NotFoundException();
    const steps = await this.db.select().from(stepRuns).where(eq(stepRuns.runId, id)).orderBy(asc(stepRuns.createdAt), asc(stepRuns.attempt));
    const hide = await this.hide(user.workspaceId);
    return {
      ...run,
      triggerPayload: hide(run.triggerPayload),
      error: hide(run.error),
      steps: steps.map((s) => ({ ...s, input: hide(s.input), output: hide(s.output), error: hide(s.error) })),
    };
  }

  /** Runs joined to their workflow, so every query can filter on the owner. Lease columns stay internal. */
  private owned() {
    const { id, state, triggerPayload, test, live, aiLive, testChoices, error, nextAttemptAt, createdAt, finishedAt } = runs;
    return this.db
      .select({ id, state, triggerPayload, test, live, aiLive, testChoices, error, nextAttemptAt, createdAt, finishedAt, workflowId: workflows.id, version: workflowVersions.version })
      .from(runs)
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .$dynamic();
  }
}
