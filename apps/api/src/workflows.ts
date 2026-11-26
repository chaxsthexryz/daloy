import { randomBytes } from "node:crypto";
import { createKeyedRun, deliveries, listDeliveries, publishedVersion, requests, runs, SCHEDULE_QUEUE, setPaused, supersededSql, syncEmailSourceOnPublish, triggers, unismsConfig, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { BRANCHES, choiceProblems, definitionSchema, testChoicesSchema, testModeSchema, guidedSetupInput, OFFICE_REQUEST, saveProblems, stepJsonSchemas, templatesForLanguage, triggerFields, type Trigger, type WorkflowDefinition } from "@daloy/engine";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { and, desc, eq, getTableColumns, inArray, max, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, BOSS, CONFIG, CurrentUser, DB, enqueueRun, eventKey, isUniqueViolation, replayedRun, validPayload, ZodPipe, type ApiConfig, type SessionUser, MANAGE, OPERATE } from "./http";
import { historyHider } from "./mask";
import { APP_PROVIDERS, evaluateReadiness, evaluateReadinessWithEnv, loadWorkspaceReadinessEnv } from "./readiness";
import { resourcesFor } from "./resources";

const workflowInput = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "use a-z, 0-9 and -"),
});
const renameInput = workflowInput.pick({ name: true });
const versionInput = z.object({ definition: z.unknown(), publish: z.boolean().default(false) });
const readinessInput = z.object({ definition: z.unknown(), workflowId: z.uuid().optional() });
const runInput = z.object({ payload: z.record(z.string(), z.unknown()).default({}) });
// mode replaces live (kept for older clients): mock fakes every outside call, ai calls only the model, live calls everything.
const testRunInput = runInput.extend({ definition: z.unknown(), live: z.boolean().default(false), mode: testModeSchema.optional(), choices: testChoicesSchema.default({}) });
const workflowId = new ZodPipe(z.uuid());
const versionNumber = new ZodPipe(z.coerce.number().int().min(1).max(1_000_000));
/** The viewer's time zone, so "today" and the day bars follow their calendar. ICU checks the name; the database receives it as a bound parameter. */
const timeZone = new ZodPipe(
  z
    .string()
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "not a time zone")
    .default("Asia/Manila"),
);

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Controller("workflows")
@UseGuards(SessionGuard, Allow(OPERATE))
export class WorkflowsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  /**
   * live: the workflow has a published version, which for a guided template means it is accepting requests.
   * formId: the form trigger's id. last: its newest real (non-test) run with the flags the Automations home turns into a plain state, or null.
   */
  @Get()
  async list(@CurrentUser() user: SessionUser) {
    // Drizzle drops the table name from a column in a one-table select, which would make "id" below mean the subquery's own id: name the table.
    const wfId = sql.raw('"workflows"."id"');
    const live = sql<boolean>`exists (select 1 from ${workflowVersions} where ${workflowVersions.workflowId} = ${wfId} and ${workflowVersions.published})`;
    // formId: the public form's id once it exists, for "Copy form link".
    const formId = sql<string | null>`(select ${triggers.id} from ${triggers} where ${triggers.workflowId} = ${wfId} and ${triggers.type} = 'form')`;
    const list = await this.db
      .select({ ...getTableColumns(workflows), live, formId })
      .from(workflows)
      .where(eq(workflows.userId, user.workspaceId))
      .orderBy(desc(workflows.createdAt));
    const inReview = (state: string) => sql<boolean>`exists (select 1 from ${deliveries} where ${deliveries.runId} = ${runs.id} and ${deliveries.state} = ${state})`;
    const newest = await this.db
      .selectDistinctOn([workflowVersions.workflowId], {
        workflowId: workflowVersions.workflowId,
        runId: runs.id,
        state: runs.state,
        createdAt: runs.createdAt,
        needsReview: sql<boolean>`(${runs.state} = 'needs_review' or ${inReview("needs_review")})`,
        deliveryFailed: inReview("failed"),
        superseded: sql<boolean>`(${runs.state} in ('pending', 'running', 'waiting', 'needs_review') and ${supersededSql})`,
        reference: sql<string | null>`(select ${requests.reference} from ${requests} where ${requests.runId} = ${runs.id})`,
      })
      .from(runs)
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(and(eq(workflows.userId, user.workspaceId), eq(runs.test, false)))
      .orderBy(workflowVersions.workflowId, desc(runs.createdAt));
    return list.map((w) => {
      const found = newest.find((n) => n.workflowId === w.id);
      return { ...w, last: found ? { ...found, workflowId: undefined } : null };
    });
  }

  /**
   * One entry per automation for the Automations table: real, non-test run counts for today and the last seven calendar days
   * in the viewer's zone (tz, default Asia/Manila), the trigger type and the apps its steps use, from the live version or else the
   * newest draft, and the workspace owner. Three queries however many automations or runs there are. Declared before :id.
   * The owner is the workspace owner: an automation has no creator of its own.
   */
  @Get("overview")
  async overview(@CurrentUser() user: SessionUser, @Query("tz", timeZone) tz: string) {
    // The same zone expression appears in several places, and the database sees each bound parameter as a different value, so the grouped columns are named by position.
    const day = sql`(${runs.createdAt} at time zone ${tz})::date`;
    const daysAgo = sql<number>`((now() at time zone ${tz})::date - ${day})`.mapWith(Number);
    const counted = await this.db
      .select({
        workflowId: workflowVersions.workflowId,
        daysAgo,
        total: sql<number>`count(*)`.mapWith(Number),
        succeeded: sql<number>`count(*) filter (where ${runs.state} = 'succeeded')`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${runs.state} = 'failed')`.mapWith(Number),
      })
      .from(runs)
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(and(eq(workflows.userId, user.workspaceId), eq(runs.test, false), sql`${day} > (now() at time zone ${tz})::date - 7`))
      .groupBy(sql`1`, sql`2`);
    // The live version when there is one, else the newest.
    const shown = await this.db
      .selectDistinctOn([workflows.id], { id: workflows.id, definition: workflowVersions.definition })
      .from(workflows)
      .leftJoin(workflowVersions, eq(workflowVersions.workflowId, workflows.id))
      .where(eq(workflows.userId, user.workspaceId))
      .orderBy(workflows.id, desc(workflowVersions.published), desc(workflowVersions.version));
    const [owner] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, user.workspaceId));
    return shown.map((w) => {
      const def = w.definition as { trigger?: { type?: string }; steps?: { type?: string }[] } | null;
      const apps = [...new Set((def?.steps ?? []).flatMap((s) => (s.type ? (APP_PROVIDERS[s.type] ?? []) : [])))];
      const days = Array.from({ length: 7 }, () => ({ total: 0, failed: false }));
      const mine = { today: 0, week: 0, succeeded: 0, failed: 0 };
      for (const c of counted.filter((x) => x.workflowId === w.id)) {
        const bar = days[6 - c.daysAgo];
        if (!bar) continue;
        bar.total += c.total;
        bar.failed ||= c.failed > 0;
        mine.week += c.total;
        mine.succeeded += c.succeeded;
        mine.failed += c.failed;
        if (c.daysAgo === 0) mine.today += c.total;
      }
      return { id: w.id, trigger: def?.trigger?.type ?? null, owner: { email: owner!.email }, apps, runs: { ...mine, days } };
    });
  }

  @Post()
  @UseGuards(Allow(MANAGE))
  async create(@CurrentUser() user: SessionUser, @Body(new ZodPipe(workflowInput)) body: z.output<typeof workflowInput>) {
    try {
      const [wf] = await this.db.insert(workflows).values({ userId: user.workspaceId, ...body }).returning();
      return wf;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("slug already in use");
      throw err;
    }
  }

  @Post("readiness")
  @UseGuards(Allow(MANAGE))
  @HttpCode(200)
  async checkReadiness(@CurrentUser() user: SessionUser, @Body(new ZodPipe(readinessInput)) body: z.output<typeof readinessInput>) {
    if (body.workflowId) await this.owned(user.workspaceId, body.workflowId);
    const parsed = definitionSchema.safeParse(body.definition);
    if (!parsed.success) {
      return {
        ready: false,
        blockers: parsed.error.issues.map((issue, idx) => ({
          id: `config:schema:${idx}`,
          kind: "config" as const,
          severity: "blocker" as const,
          text: `${issue.path.join(".") || "definition"}: ${issue.message}`,
          ...(body.workflowId ? { fix: `#/w/${body.workflowId}` } : {}),
        })),
        warnings: [],
      };
    }
    return evaluateReadiness(
      { db: this.db },
      { workspaceId: user.workspaceId, definition: parsed.data, workflowId: body.workflowId, language: user.language },
    );
  }

  @Get(":id/readiness")
  async readiness(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string) {
    await this.owned(user.workspaceId, id);
    const live = await publishedVersion(this.db, id);
    const [latest] = live
      ? [live]
      : await this.db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, id)).orderBy(desc(workflowVersions.version)).limit(1);
    if (!latest) {
      return {
        ready: false,
        blockers: [
          {
            id: "config:no_version",
            kind: "config" as const,
            severity: "blocker" as const,
            text: user.language === "tl" ? "Magdagdag muna ng kahit isang hakbang bago i-on." : "Add at least one step before turning this on.",
            fix: `#/w/${id}`,
          },
        ],
        warnings: [],
      };
    }
    const parsed = definitionSchema.safeParse(latest.definition);
    if (!parsed.success) {
      return {
        ready: false,
        blockers: parsed.error.issues.map((issue, idx) => ({
          id: `config:schema:${idx}`,
          kind: "config" as const,
          severity: "blocker" as const,
          text: `${issue.path.join(".") || "definition"}: ${issue.message}`,
          fix: `#/w/${id}`,
        })),
        warnings: [],
      };
    }
    return evaluateReadiness({ db: this.db }, { workspaceId: user.workspaceId, definition: parsed.data, workflowId: id, language: user.language });
  }

  @Get(":id")
  async get(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string) {
    const wf = await this.owned(user.workspaceId, id);
    const [trigger] = await this.db.select().from(triggers).where(eq(triggers.workflowId, id));
    // latest is what the builder opens: the newest version, published or draft.
    const [latest] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, id)).orderBy(desc(workflowVersions.version)).limit(1);
    // The webhook path is a bearer URL: only roles that manage the workflow see it.
    const shown = trigger && !MANAGE.includes(user.role) ? { ...trigger, webhookPath: null } : (trigger ?? null);
    return { ...wf, trigger: shown, live: (await publishedVersion(this.db, id)) ?? null, latest: latest ?? null };
  }

  /** Replaces the webhook URL. The old one stops working at once. */
  @Post(":id/webhook-url")
  @UseGuards(Allow(MANAGE))
  async rotateWebhookUrl(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string) {
    await this.owned(user.workspaceId, id);
    const webhookPath = randomBytes(32).toString("base64url");
    const rows = await this.db
      .update(triggers)
      .set({ webhookPath })
      .where(and(eq(triggers.workflowId, id), inArray(triggers.type, [...HAS_WEBHOOK_PATH])))
      .returning({ id: triggers.id });
    if (rows.length === 0) throw new NotFoundException("this workflow has no webhook trigger");
    return { webhookPath };
  }

  @Patch(":id")
  @UseGuards(Allow(MANAGE))
  async rename(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string, @Body(new ZodPipe(renameInput)) body: z.output<typeof renameInput>) {
    await this.owned(user.workspaceId, id);
    const [wf] = await this.db.update(workflows).set(body).where(eq(workflows.id, id)).returning();
    return wf;
  }

  /** Saves guided setup progress, so "Save and finish later" and a closed tab both resume at the same step. */
  @Patch(":id/setup")
  @UseGuards(Allow(MANAGE))
  async saveSetup(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string, @Body(new ZodPipe(guidedSetupInput)) body: z.output<typeof guidedSetupInput>) {
    await this.owned(user.workspaceId, id);
    const [wf] = await this.db
      .update(workflows)
      .set({ setup: { ...body, template: body.template ?? OFFICE_REQUEST } })
      .where(eq(workflows.id, id))
      .returning();
    return wf;
  }

  /**
   * The office request list: newest first, with the state of the run that sends the notification and the receipt,
   * and each Sheets or Slack delivery with its own state, so one can be retried on its own.
   */
  @Get(":id/requests")
  async listRequests(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string) {
    await this.owned(user.workspaceId, id);
    const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
    const { id: requestId, reference, subject, createdAt, runId } = requests;
    const rows = await this.db
      .select({ id: requestId, reference, subject, createdAt, runId, runState: runs.state, runError: runs.error })
      .from(requests)
      .innerJoin(runs, eq(runs.id, requests.runId))
      .where(eq(requests.workflowId, id))
      .orderBy(desc(createdAt))
      .limit(200);
    const all = await listDeliveries(this.db, user.workspaceId, rows.map((r) => r.runId));
    return rows.map((r) => ({
      ...r,
      subject: hide(r.subject) as string,
      runError: hide(r.runError),
      deliveries: all.filter((d) => d.runId === r.runId).map((d) => ({ ...d, reference: hide(d.reference) as string, lastError: hide(d.lastError), result: hide(d.result) })),
    }));
  }

  /** Pause: no trigger starts a new run until Resume. Runs already started finish. Repeating either call changes nothing (decision 0054). */
  @Post(":id/pause")
  @UseGuards(Allow(MANAGE))
  @HttpCode(204)
  async pause(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string) {
    if (!(await setPaused(this.db, user.workspaceId, id, true))) throw new NotFoundException();
  }

  @Post(":id/resume")
  @UseGuards(Allow(MANAGE))
  @HttpCode(204)
  async resume(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string) {
    if (!(await setPaused(this.db, user.workspaceId, id, false))) throw new NotFoundException();
  }

  /** Deletes the workflow with its versions, trigger and run history. */
  @Delete(":id")
  @UseGuards(Allow(MANAGE))
  @HttpCode(204)
  async remove(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string) {
    await this.owned(user.workspaceId, id);
    await this.boss.unschedule(SCHEDULE_QUEUE, id);
    await this.db.delete(workflows).where(eq(workflows.id, id));
  }

  @Get(":id/versions")
  async versions(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string) {
    await this.owned(user.workspaceId, id);
    const { version, published, createdAt } = workflowVersions;
    return this.db.select({ id: workflowVersions.id, version, published, createdAt }).from(workflowVersions).where(eq(workflowVersions.workflowId, id)).orderBy(desc(version));
  }

  /** One version with its definition, for the version diff and rollback. */
  @Get(":id/versions/:version")
  async version(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string, @Param("version", versionNumber) version: number) {
    await this.owned(user.workspaceId, id);
    const [row] = await this.db
      .select()
      .from(workflowVersions)
      .where(and(eq(workflowVersions.workflowId, id), eq(workflowVersions.version, version)));
    if (!row) throw new NotFoundException();
    return row;
  }

  /**
   * Versions are immutable. Saving adds the next version; publishing also makes it live and syncs its trigger.
   * A rollback in the console posts an old definition here with publish: true, so it becomes a new version.
   */
  @Post(":id/versions")
  @UseGuards(Allow(MANAGE))
  async addVersion(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string, @Body(new ZodPipe(versionInput)) body: z.output<typeof versionInput>) {
    await this.owned(user.workspaceId, id);
    const definition = parseDefinition(body.definition);
    if (!body.publish) return this.saveVersion(id, definition, false);
    // The owner's row is locked from the readiness/plan check to the save, so two publishes cannot both take the last live slot.
    return this.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.workspaceId)).for("update");
      const report = await evaluateReadiness(
        { db: tx as unknown as Db },
        { workspaceId: user.workspaceId, definition, workflowId: id, language: user.language },
      );
      if (!report.ready) {
        const first = report.blockers[0]!;
        if (first.what === "automation_limit") throw new ForbiddenException(first.text);
        throw new BadRequestException(first.text);
      }
      // Scheduled before saving: pg-boss rejects a bad cron here, before anything is saved.
      await this.syncSchedule(id, definition.trigger);
      return this.saveVersion(id, definition, true, tx);
    });
  }

  /**
   * The builder's "Test run": saves the draft as an unpublished version (unless it matches the newest one)
   * and runs it as a test. http and email steps are mocked unless live is true.
   */
  @Post(":id/test-runs")
  @UseGuards(Allow(MANAGE))
  @HttpCode(202)
  async testRun(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string, @Body(new ZodPipe(testRunInput)) body: z.output<typeof testRunInput>) {
    await this.owned(user.workspaceId, id);
    const definition = parseDefinition(body.definition);
    // A test run gets the same field checks as the form or webhook it stands in for, before anything is saved.
    const fields = triggerFields(definition.trigger);
    const payload = validPayload(fields, body.payload, await resourcesFor(this.db, user.workspaceId, fields));
    const mode = body.mode ?? (body.live ? "live" : "mock");
    const problems = choiceProblems(definition, body.choices, mode);
    if (problems.length > 0) throw new BadRequestException(problems);
    const [latest] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, id)).orderBy(desc(workflowVersions.version)).limit(1);
    const versionId = latest && canonical(latest.definition) === canonical(definition) ? latest.id : (await this.saveVersion(id, definition, false))!.id;
    const opts = { test: true, live: mode === "live", aiLive: mode === "ai", testChoices: Object.keys(body.choices).length > 0 ? body.choices : null };
    const { runId, duplicate } = await createKeyedRun(this.db, id, versionId, payload, eventKey(definition.trigger, payload), opts);
    if (!duplicate) {
      await enqueueRun(this.boss, runId);
      return { id: runId, versionId };
    }
    // The event already ran: answer with what that run was, not with this request's draft and mode.
    const [ran] = await this.db.select({ versionId: runs.workflowVersionId, live: runs.live, aiLive: runs.aiLive }).from(runs).where(eq(runs.id, runId));
    return { id: runId, versionId: ran!.versionId, mode: ran!.live ? "live" : ran!.aiLive ? "ai" : "mock", duplicate };
  }

  private async saveVersion(id: string, definition: WorkflowDefinition, publish: boolean, outer: Pick<Db, "transaction"> = this.db) {
    try {
      return await outer.transaction(async (tx) => {
        const [{ latest }] = (await tx.select({ latest: max(workflowVersions.version) }).from(workflowVersions).where(eq(workflowVersions.workflowId, id))) as [{ latest: number | null }];
        const [row] = await tx
          .insert(workflowVersions)
          .values({ workflowId: id, version: (latest ?? 0) + 1, definition, published: publish })
          .returning({ id: workflowVersions.id, version: workflowVersions.version, published: workflowVersions.published });
        if (publish) {
          await syncEmailSourceOnPublish(tx, id, definition.trigger.type);
          await syncTrigger(tx, id, definition.trigger);
        }
        return row;
      });
    } catch (err) {
      // Two saves at the same moment computed the same version number.
      if (isUniqueViolation(err)) throw new ConflictException("another version was saved at the same time, try again");
      throw err;
    }
  }

  /** The console's "Run" button: runs the live version with the given payload, whatever the trigger type. */
  @Post(":id/runs")
  @UseGuards(Allow(MANAGE))
  @HttpCode(202)
  async run(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string, @Body(new ZodPipe(runInput)) body: z.output<typeof runInput>) {
    await this.owned(user.workspaceId, id);
    const version = await publishedVersion(this.db, id);
    if (!version) throw new ConflictException("publish the workflow first");
    const { trigger } = definitionSchema.parse(version.definition);
    const first = await replayedRun(this.db, id, trigger, body.payload);
    if (first) return { id: first, duplicate: true };
    const fields = triggerFields(trigger);
    const payload = validPayload(fields, body.payload, await resourcesFor(this.db, user.workspaceId, fields));
    const { runId, duplicate } = await createKeyedRun(this.db, id, version.id, payload, eventKey(trigger, payload));
    if (!duplicate) await enqueueRun(this.boss, runId);
    return duplicate ? { id: runId, duplicate } : { id: runId };
  }

  private async owned(userId: string, id: string) {
    const [wf] = await this.db.select().from(workflows).where(and(eq(workflows.id, id), eq(workflows.userId, userId)));
    if (!wf) throw new NotFoundException();
    return wf;
  }

  private async syncSchedule(id: string, trigger: Trigger) {
    if (trigger.type !== "schedule") return this.boss.unschedule(SCHEDULE_QUEUE, id);
    try {
      await this.boss.schedule(SCHEDULE_QUEUE, trigger.config.cron, { workflowId: id }, { key: id });
    } catch (err) {
      throw new BadRequestException(`trigger.config.cron: ${err instanceof Error ? err.message : "invalid"}`);
    }
  }
}

function parseDefinition(input: unknown): WorkflowDefinition {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join(".") || "definition"}: ${i.message}`));
  // JSON bodies, secrets outside HTTP steps and secrets sent to data-chosen addresses (decision 0025).
  const problems = saveProblems(parsed.data);
  if (problems.length > 0) throw new BadRequestException(problems);
  return parsed.data;
}

/** JSON with sorted keys. Postgres jsonb reorders object keys, so plain JSON.stringify cannot compare a stored definition. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/** Read-only data the builder needs: a form schema per step type, branch labels, and the starter templates. */
@Controller()
@UseGuards(SessionGuard, Allow(OPERATE))
export class CatalogController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("step-schemas")
  stepSchemas() {
    // sms: whether this server has UniSMS settings (decision 0100), so the web app can hide the SMS step when it has not.
    return { schemas: stepJsonSchemas(), branches: BRANCHES, sms: unismsConfig() !== null };
  }

  @Get("templates")
  templates(@CurrentUser() user: SessionUser) {
    return templatesForLanguage(user.language);
  }

  @Get("templates/readiness")
  async templateReadiness(@CurrentUser() user: SessionUser) {
    const env = await loadWorkspaceReadinessEnv(this.db, user.workspaceId);
    const list = templatesForLanguage(user.language);
    return Promise.all(
      list.map(async (item) => {
        const report = await evaluateReadinessWithEnv(this.db, env, {
          workspaceId: user.workspaceId,
          definition: item.definition as WorkflowDefinition,
          language: user.language,
        });
        return { slug: item.slug, ...report };
      }),
    );
  }
}

const HAS_WEBHOOK_PATH = new Set(["webhook", "slack_message", "teams_message", "discord_message"]);

/** One trigger row per workflow, matching the live version. A webhook keeps its path across publishes so its URL never changes. */
async function syncTrigger(tx: Tx, id: string, trigger: Trigger) {
  const [existing] = await tx.select().from(triggers).where(eq(triggers.workflowId, id));
  const webhookPath = HAS_WEBHOOK_PATH.has(trigger.type) ? (existing?.webhookPath ?? randomBytes(32).toString("base64url")) : null;
  const values = { type: trigger.type, config: trigger.config, webhookPath };
  if (existing) await tx.update(triggers).set(values).where(eq(triggers.id, existing.id));
  else await tx.insert(triggers).values({ workflowId: id, ...values });
}
