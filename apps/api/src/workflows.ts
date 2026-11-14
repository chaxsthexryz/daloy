import { randomBytes } from "node:crypto";
import { createKeyedRun, findApprover, listDeliveries, PROVIDER_NAMES, type Provider, publishedVersion, readConnections, requests, runs, SCHEDULE_QUEUE, triggers, workflows, workflowVersions, type Db } from "@daloy/db";
import { BRANCHES, choiceProblems, definitionSchema, testChoicesSchema, testModeSchema, guidedSetupInput, OFFICE_REQUEST, saveProblems, stepJsonSchemas, TEMPLATES, triggerFields, type Trigger, type WorkflowDefinition } from "@daloy/engine";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { and, desc, eq, getTableColumns, max, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, BOSS, CurrentUser, DB, enqueueRun, eventKey, isUniqueViolation, validPayload, ZodPipe, type SessionUser, MANAGE, OPERATE } from "./http";
import { resourcesFor } from "./resources";

const workflowInput = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "use a-z, 0-9 and -"),
});
const renameInput = workflowInput.pick({ name: true });
const versionInput = z.object({ definition: z.unknown(), publish: z.boolean().default(false) });
const runInput = z.object({ payload: z.record(z.string(), z.unknown()).default({}) });
// mode replaces live (kept for older clients): mock fakes every outside call, ai calls only the model, live calls everything.
const testRunInput = runInput.extend({ definition: z.unknown(), live: z.boolean().default(false), mode: testModeSchema.optional(), choices: testChoicesSchema.default({}) });
const workflowId = new ZodPipe(z.uuid());
const versionNumber = new ZodPipe(z.coerce.number().int().min(1).max(1_000_000));

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Controller("workflows")
@UseGuards(SessionGuard, Allow(OPERATE))
export class WorkflowsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
  ) {}

  /** live: the workflow has a published version, which for a guided template means it is accepting requests. */
  @Get()
  list(@CurrentUser() user: SessionUser) {
    const live = sql<boolean>`exists (select 1 from ${workflowVersions} where ${workflowVersions.workflowId} = ${workflows.id} and ${workflowVersions.published})`;
    return this.db
      .select({ ...getTableColumns(workflows), live })
      .from(workflows)
      .where(eq(workflows.userId, user.workspaceId))
      .orderBy(desc(workflows.createdAt));
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

  @Get(":id")
  async get(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string) {
    const wf = await this.owned(user.workspaceId, id);
    const [trigger] = await this.db.select().from(triggers).where(eq(triggers.workflowId, id));
    // latest is what the builder opens: the newest version, published or draft.
    const [latest] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, id)).orderBy(desc(workflowVersions.version)).limit(1);
    return { ...wf, trigger: trigger ?? null, live: (await publishedVersion(this.db, id)) ?? null, latest: latest ?? null };
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
    const { id: requestId, reference, subject, createdAt, runId } = requests;
    const rows = await this.db
      .select({ id: requestId, reference, subject, createdAt, runId, runState: runs.state, runError: runs.error })
      .from(requests)
      .innerJoin(runs, eq(runs.id, requests.runId))
      .where(eq(requests.workflowId, id))
      .orderBy(desc(createdAt))
      .limit(200);
    const all = await listDeliveries(this.db, user.workspaceId, rows.map((r) => r.runId));
    return rows.map((r) => ({ ...r, deliveries: all.filter((d) => d.runId === r.runId) }));
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

    if (body.publish) await this.checkConnections(user.workspaceId, definition);
    if (body.publish) await this.checkApprovers(user.workspaceId, definition);
    // Scheduled first: pg-boss rejects a bad cron here, before anything is saved.
    if (body.publish) await this.syncSchedule(id, definition.trigger);
    return this.saveVersion(id, definition, body.publish);
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

  /** Turning on a workflow with Sheets, Slack, Outlook or Teams steps needs that connection working with a destination. Drafts do not. */
  private async checkConnections(userId: string, definition: WorkflowDefinition) {
    const providers: Partial<Record<string, Provider>> = { sheets: "google_sheets", slack: "slack", outlook: "outlook", teams: "teams" };
    const needed = new Set(definition.steps.flatMap((s) => providers[s.type] ?? []));
    if (needed.size === 0) return;
    const conns = await readConnections(this.db, userId);
    for (const provider of needed) {
      const c = conns.find((x) => x.provider === provider);
      const name = PROVIDER_NAMES[provider];
      const where = provider === "slack" ? " and pick a channel" : provider === "google_sheets" ? " and pick a sheet" : "";
      if (!c || !c.destination) throw new BadRequestException(`Connect ${name}${where} in Settings, Business and email before turning this on.`);
      if (c.status !== "active") throw new BadRequestException(`${name} needs to be connected again in Settings, Business and email before turning this on.`);
    }
  }

  /** A named approver must be a member who may approve when the workflow is turned on; the worker and the approval page check again later. */
  private async checkApprovers(workspaceId: string, definition: WorkflowDefinition) {
    for (const step of definition.steps) {
      if (step.type !== "approval" || !step.config.approver) continue;
      if (!(await findApprover(this.db, workspaceId, step.config.approver))) {
        throw new BadRequestException(`${step.config.approver} can't approve in this workspace. Invite them as an approver on the Team page first.`);
      }
    }
  }

  private async saveVersion(id: string, definition: WorkflowDefinition, publish: boolean) {
    try {
      return await this.db.transaction(async (tx) => {
        const [{ latest }] = (await tx.select({ latest: max(workflowVersions.version) }).from(workflowVersions).where(eq(workflowVersions.workflowId, id))) as [{ latest: number | null }];
        const [row] = await tx
          .insert(workflowVersions)
          .values({ workflowId: id, version: (latest ?? 0) + 1, definition, published: publish })
          .returning({ id: workflowVersions.id, version: workflowVersions.version, published: workflowVersions.published });
        if (publish) await syncTrigger(tx, id, definition.trigger);
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
  @Get("step-schemas")
  stepSchemas() {
    return { schemas: stepJsonSchemas(), branches: BRANCHES };
  }

  @Get("templates")
  templates() {
    return TEMPLATES;
  }
}

/** One trigger row per workflow, matching the live version. A webhook keeps its path across publishes so its URL never changes. */
async function syncTrigger(tx: Tx, id: string, trigger: Trigger) {
  const [existing] = await tx.select().from(triggers).where(eq(triggers.workflowId, id));
  const webhookPath = trigger.type === "webhook" ? (existing?.webhookPath ?? randomBytes(32).toString("base64url")) : null;
  const values = { type: trigger.type, config: trigger.config, webhookPath };
  if (existing) await tx.update(triggers).set(values).where(eq(triggers.id, existing.id));
  else await tx.insert(triggers).values({ workflowId: id, ...values });
}
