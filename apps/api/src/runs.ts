import { deliveries, redactSecrets, requests, resolveRun, runs, secretForms, supersededSql, secretValuesToHide, stepRuns, workflows, workflowVersions, type Db, type RunAction } from "@daloy/db";
import { Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, BOSS, CONFIG, CurrentUser, DB, enqueueRun, RateLimit, ZodPipe, type ApiConfig, type SessionUser, OPERATE } from "./http";
import { maskSecrets } from "./mask";

const testFlag = new ZodPipe(z.enum(["true", "false"]).optional());
const resolveInput = z.object({ action: z.enum(["delivered", "again", "stop"]) });
const uuid = new ZodPipe(z.uuid());
// A run that waits for a person: parked itself, or one of its Sheets or Slack deliveries is.
const deliveryIn = (state: string) => sql<boolean>`exists (select 1 from ${deliveries} where ${deliveries.runId} = ${runs.id} and ${deliveries.state} = ${state})`;
const deliveryInReview = deliveryIn("needs_review");
// The owner's plain states (apps/web/src/lib/states.ts): a failed delivery is a Problem too.
const STATES = {
  problem: or(eq(runs.state, "failed"), deliveryIn("failed")),
  waiting: eq(runs.state, "waiting"),
  done: eq(runs.state, "succeeded"),
};
const reference = sql<string | null>`(select ${requests.reference} from ${requests} where ${requests.runId} = ${runs.id})`;
// Text to find, with LIKE's wildcards matched as themselves.
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

/**
 * Run history, plus the operator's answers to a run in review (decision 0030). On the way out, every payload, step input, output and error first has every form of the
 * workspace's current and retired secret values replaced (decision 0025), so a row written before a redaction fix, or
 * before a rotation, still hides them. maskSecrets then hides values under secret-looking keys.
 */
@Controller("runs")
@UseGuards(SessionGuard, Allow(OPERATE))
export class RunsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
    @Inject(BOSS) private readonly boss: PgBoss,
  ) {}

  private async hide(workspaceId: string) {
    const forms = secretForms(await secretValuesToHide(this.db, this.config.secretsKey, workspaceId));
    return (v: unknown) => maskSecrets(redactSecrets(v, forms));
  }

  /**
   * The latest 50 runs, newest first. test=true lists builder test runs only, test=false the others. review=true lists runs
   * waiting for a person, state one plain state, and q runs whose automation name or request reference contains the text.
   */
  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query("workflowId", new ZodPipe(z.uuid().optional())) workflowId?: string,
    @Query("test", testFlag) test?: "true" | "false",
    @Query("review", new ZodPipe(z.literal("true").optional())) review?: "true",
    @Query("state", new ZodPipe(z.enum(["problem", "waiting", "done"]).optional())) state?: keyof typeof STATES,
    @Query("q", new ZodPipe(z.string().trim().max(100).optional())) q?: string,
  ) {
    const rows = await this.owned()
      .where(
        and(
          eq(workflows.userId, user.workspaceId),
          workflowId ? eq(workflows.id, workflowId) : undefined,
          test ? eq(runs.test, test === "true") : undefined,
          review ? or(eq(runs.state, "needs_review"), deliveryInReview) : undefined,
          state ? STATES[state] : undefined,
          q ? or(ilike(workflows.name, like(q)), sql`${reference} ilike ${like(q)}`) : undefined,
        ),
      )
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

  /** It went through, Send again or Stop, for a run in review. Of two operators acting at once, the second gets a 409. */
  @Post(":id/resolve")
  @HttpCode(204)
  @UseGuards(RateLimit(30))
  async resolve(@CurrentUser() user: SessionUser, @Param("id", uuid) id: string, @Body(new ZodPipe(resolveInput)) body: z.output<typeof resolveInput>) {
    await this.act(user, id, body.action);
  }

  /** One more attempt of the step a failed run stopped at, with the same step key. */
  @Post(":id/retry")
  @HttpCode(204)
  @UseGuards(RateLimit(30))
  async retry(@CurrentUser() user: SessionUser, @Param("id", uuid) id: string) {
    await this.act(user, id, "retry");
  }

  private async act(user: SessionUser, id: string, action: RunAction) {
    if (await resolveRun(this.db, user.workspaceId, id, action, user.email)) {
      if (action !== "stop") await enqueueRun(this.boss, id);
      return;
    }
    // Someone else's run and an unknown id look the same. Your own one in another state is a 409 that names the state.
    const [run] = await this.owned().where(and(eq(workflows.userId, user.workspaceId), eq(runs.id, id)));
    if (!run) throw new NotFoundException();
    throw new ConflictException(`This run is ${run.state.replace("_", " ")}, so there is nothing to do.`);
  }

  /** Runs joined to their workflow, so every query can filter on the owner. Lease columns stay internal. */
  private owned() {
    const { id, state, triggerPayload, test, live, aiLive, testChoices, error, nextAttemptAt, createdAt, finishedAt } = runs;
    return this.db
      .select({
        id,
        state,
        triggerPayload,
        test,
        live,
        aiLive,
        testChoices,
        error,
        nextAttemptAt,
        createdAt,
        finishedAt,
        needsReview: sql<boolean>`(${runs.state} = 'needs_review' or ${deliveryInReview})`,
        // Not finished, but its booking was changed since: it stops at its next step and sends nothing more (decision 0032).
        superseded: sql<boolean>`(${runs.state} in ('pending', 'running', 'waiting', 'needs_review') and ${supersededSql})`,
        workflowId: workflows.id,
        workflowName: workflows.name,
        reference,
        version: workflowVersions.version,
      })
      .from(runs)
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .$dynamic();
  }
}
