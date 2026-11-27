import { aiConnection, cancelRun, claimUsage, readUpload, deliveries, listDeliveries, QuotaError, refundUsage, requests, resolveRun, runs, supersededSql, stepRuns, users, workflows, workflowVersions, type Db, type RunAction } from "@daloy/db";
import { FILE_MIME, safeFileName } from "@daloy/engine";
import { generate } from "@daloy/llm-ts";
import { Body, ConflictException, Controller, Get, Header, HttpCode, HttpException, HttpStatus, Inject, NotFoundException, Param, Post, Query, Res, StreamableFile, UseGuards } from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { Response } from "express";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { toCsv } from "./csv";
import { answerAll, askFacts, explainFailure, failureFacts } from "./explain";
import { Allow, BOSS, CONFIG, CurrentUser, DB, enqueueRun, RateLimit, ZodPipe, type ApiConfig, type SessionUser, MANAGE, OPERATE } from "./http";
import { historyHider } from "./mask";
import { explainForOwner } from "./settings";

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

const REWORD_SYSTEM =
  "You explain why a kymavo automation stopped, for a small office owner. You get JSON with facts and a fixed explanation. Write 2 to 4 short, plain sentences. Write in plain Tagalog (Taglish is fine) when language is tl, otherwise in English. Keep the fix from the fixed explanation. Use the words automation, Apps and Activity. Never give links or addresses. Never guess causes that are not in the facts. Reply with the text only.";

const ASK_SYSTEM =
  "You answer one question about a kymavo request, for a small office owner. You get JSON with the question (happened, why or next), the language, facts and a fixed answer. Answer only that question in 2 to 4 short, plain sentences. Write in plain Tagalog (Taglish is fine) when language is tl, otherwise in English. Keep the fix from the fixed answer. Use the words automation, Apps and Activity. Never give links or addresses. Never guess causes that are not in the facts. Reply with the text only.";
const askReference = z.string().trim().min(1).max(60);
const askReword = z.object({ reference: askReference, question: z.enum(["happened", "why", "next"]), language: z.enum(["en", "tl"]).optional() });

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
    @Query("limit", new ZodPipe(z.coerce.number().int().min(1).max(50).optional())) limit?: number,
  ) {
    // Load the hider before the rows, so a concurrent retired-secret purge cannot remove a secret between the two queries.
    const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
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
      .limit(limit ?? 50);
    return rows.map((r) => ({ ...r, triggerPayload: hide(r.triggerPayload), error: hide(r.error) as string | null }));
  }

  /** The three fixed answers about a request, found by its reference (phase N10b). 404 while the switch is off. Read-only. */
  @Get("ask")
  async ask(@CurrentUser() user: SessionUser, @Query("reference", new ZodPipe(askReference)) reference: string) {
    const { found, facts } = await this.asked(user.workspaceId, reference);
    return { ...found, answers: answerAll(facts, user.language) };
  }

  /** One of those answers reworded by the workspace's AI model, from the same closed-set facts. Costs one AI action, writes nothing else. */
  @Post("ask/reword")
  @HttpCode(200)
  @UseGuards(Allow(MANAGE), RateLimit(10))
  async askReword(@CurrentUser() user: SessionUser, @Body(new ZodPipe(askReword)) body: z.output<typeof askReword>) {
    const { facts } = await this.asked(user.workspaceId, body.reference);
    const language = body.language ?? user.language;
    const fixed = answerAll(facts, language)[body.question];
    if (!fixed) throw new ConflictException("There is nothing to explain for this question.");
    return this.reworded(user.workspaceId, ASK_SYSTEM, { question: body.question, language, facts, fixed });
  }

  /** One automation's Activity as CSV: the request, state and dates, then every form field. Secrets are hidden as in the list; spreadsheet formulas are defused (phase N19). */
  @Get("export.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="activity.csv"')
  async exportCsv(@CurrentUser() user: SessionUser, @Query("workflowId", uuid) workflowId: string) {
    const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
    const rows = await this.owned().where(and(eq(workflows.userId, user.workspaceId), eq(workflows.id, workflowId))).orderBy(desc(runs.createdAt)).limit(5000);
    const fields = rows.map((r) => {
      const p = hide(r.triggerPayload);
      return p !== null && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    });
    const names = [...new Set(fields.flatMap((f) => Object.keys(f)))];
    return toCsv(
      ["reference", "state", "test", "created", "finished", ...names],
      rows.map((r, i) => [r.reference, r.state, r.test, r.createdAt.toISOString(), r.finishedAt?.toISOString(), ...names.map((n) => fields[i]![n])]),
    );
  }

  /** A file a form collected, for the owner and operators of the run's workspace. Always a download, never shown by the browser (phase N21). */
  @Get(":runId/files/:fileId")
  async file(@CurrentUser() user: SessionUser, @Param("runId", uuid) runId: string, @Param("fileId", uuid) fileId: string, @Res({ passthrough: true }) res: Response) {
    const [run] = await this.owned().where(and(eq(workflows.userId, user.workspaceId), eq(runs.id, runId)));
    const file = run && (await readUpload(this.db, { userId: user.workspaceId, runId, id: fileId }));
    if (!file) throw new NotFoundException();
    res.set({
      "Content-Type": FILE_MIME[file.type],
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(file.name))}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    });
    return new StreamableFile(file.data);
  }

  @Get(":id")
  async get(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
    const [run] = await this.owned().where(and(eq(workflows.userId, user.workspaceId), eq(runs.id, id)));
    if (!run) throw new NotFoundException();
    const steps = await this.db.select().from(stepRuns).where(eq(stepRuns.runId, id)).orderBy(asc(stepRuns.createdAt), asc(stepRuns.attempt));
    // A decided approval stores the decider's email; show their name instead when they have set one (decision 0154).
    const deciders = [...new Set(steps.flatMap((s) => { const d = (s.output as { decidedBy?: unknown } | null)?.decidedBy; return typeof d === "string" ? [d] : []; }))];
    const names = new Map(deciders.length ? (await this.db.select({ email: users.email, name: users.displayName }).from(users).where(inArray(users.email, deciders))).map((u) => [u.email, u.name] as const) : []);
    const named = (output: unknown) => {
      const o = output as { decidedBy?: unknown } | null;
      return typeof o?.decidedBy === "string" && names.get(o.decidedBy) ? { ...o, decidedBy: names.get(o.decidedBy) } : output;
    };
    return {
      ...run,
      triggerPayload: hide(run.triggerPayload),
      error: hide(run.error),
      steps: steps.map((s) => ({ ...s, input: hide(s.input), output: named(hide(s.output)), error: hide(s.error) })),
    };
  }

  /** Why a failed run stopped, in plain words, from a fixed table. No model, no usage. null when nothing failed. */
  @Get(":id/explanation")
  async explanation(@CurrentUser() user: SessionUser, @Param("id", uuid) id: string) {
    return this.explained(user.workspaceId, id, user.language);
  }

  /**
   * The same explanation reworded by the workspace's AI model. The model gets only the closed-set facts and the fixed
   * text, never an error, id, address or payload. Writes nothing; costs one AI action.
   */
  @Post(":id/explanation/reword")
  @HttpCode(200)
  @UseGuards(Allow(MANAGE), RateLimit(10))
  async reword(@CurrentUser() user: SessionUser, @Param("id", uuid) id: string) {
    const input = await this.explained(user.workspaceId, id, user.language);
    if (!input) throw new ConflictException("There is nothing to explain for this run.");
    return this.reworded(user.workspaceId, REWORD_SYSTEM, { ...input, language: user.language });
  }

  private async reworded(workspaceId: string, system: string, input: unknown) {
    // The connection first, as in /ai/draft: a missing key costs no AI action.
    const { model, ...connection } = await aiConnection(this.db, this.config.secretsKey, workspaceId).catch((err: unknown) => {
      throw new HttpException({ message: explainForOwner(err) }, HttpStatus.BAD_GATEWAY);
    });
    const now = new Date();
    await claimUsage(this.db, workspaceId, "ai", { now }).catch((err: unknown) => {
      throw err instanceof QuotaError ? new HttpException({ message: err.message }, HttpStatus.TOO_MANY_REQUESTS) : err;
    });
    try {
      let text: string;
      try {
        ({ text } = await generate({ system, messages: [{ role: "user", content: JSON.stringify(input) }], model, connection, temperature: 0.2, maxTokens: 300, timeoutMs: 30_000 }));
      } catch (err) {
        throw new HttpException({ message: explainForOwner(err) }, HttpStatus.BAD_GATEWAY);
      }
      text = text.trim().slice(0, 600);
      if (!text || /https?:\/\/|www\./i.test(text)) throw new HttpException({ message: "The AI model could not answer." }, HttpStatus.BAD_GATEWAY);
      return { text };
    } catch (err) {
      await refundUsage(this.db, workspaceId, "ai", { now }).catch(() => undefined);
      throw err;
    }
  }

  /** Everything the explanations read for one run of this workspace. */
  private async loaded(workspaceId: string, id: string) {
    const [run] = await this.db
      .select({ state: runs.state, test: runs.test, error: runs.error, definition: workflowVersions.definition })
      .from(runs)
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(and(eq(workflows.userId, workspaceId), eq(runs.id, id)));
    if (!run) throw new NotFoundException();
    const [steps, deliveries] = await Promise.all([this.db.select().from(stepRuns).where(eq(stepRuns.runId, id)), listDeliveries(this.db, workspaceId, [id])]);
    return { run, steps, deliveries, definition: run.definition };
  }

  /** The run behind a reference, or the same 404 whether the switch is off, the reference is unknown or it is another workspace's. */
  private async asked(workspaceId: string, ref: string) {
    if (!this.config.ask) throw new NotFoundException();
    const [found] = await this.db
      .select({ runId: requests.runId, reference: requests.reference, workflowName: workflows.name })
      .from(requests)
      .innerJoin(runs, eq(runs.id, requests.runId))
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(and(eq(workflows.userId, workspaceId), eq(requests.reference, ref)));
    if (!found) throw new NotFoundException();
    return { found, facts: askFacts(await this.loaded(workspaceId, found.runId)) };
  }

  private async explained(workspaceId: string, id: string, language: "en" | "tl" = "en") {
    const input = await this.loaded(workspaceId, id);
    const stuck = (s: string) => s === "failed" || s === "needs_review";
    if (!stuck(input.run.state) && !input.deliveries.some((d) => stuck(d.state))) return null;
    const facts = failureFacts(input);
    return { facts, fixed: explainFailure(facts, language) };
  }

  /** It went through, Send again or Stop, for a run in review. Of two operators acting at once, the second gets a 409. */
  @Post(":id/resolve")
  @HttpCode(204)
  @UseGuards(RateLimit(30))
  async resolve(@CurrentUser() user: SessionUser, @Param("id", uuid) id: string, @Body(new ZodPipe(resolveInput)) body: z.output<typeof resolveInput>) {
    await this.act(user, id, body.action);
  }

  /**
   * Cancels a run that has not started or is waiting on a delay or an approval. A run that is running or in review
   * is refused: review has Stop. Of two people cancelling at once, the second gets a 409 (decision 0054).
   */
  @Post(":id/cancel")
  @HttpCode(204)
  @UseGuards(RateLimit(30))
  async cancel(@CurrentUser() user: SessionUser, @Param("id", uuid) id: string) {
    if (await cancelRun(this.db, user.workspaceId, id, user.email)) return;
    const [run] = await this.owned().where(and(eq(workflows.userId, user.workspaceId), eq(runs.id, id)));
    if (!run) throw new NotFoundException();
    if (run.state === "needs_review") throw new ConflictException("This run is in review, so use Stop.");
    if (run.state === "running") throw new ConflictException("This run is running right now, so it cannot be cancelled. It stops at its next wait.");
    throw new ConflictException(`This run is ${run.state}, so it cannot be cancelled.`);
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
    if (action === "delivered" && run.state === "needs_review") throw new ConflictException("Nothing was sent for this run, so it cannot be marked as sent. Choose Send again or Stop.");
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
        deliveryFailed: deliveryIn("failed"),
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
