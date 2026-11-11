import { randomBytes } from "node:crypto";
import { createRun, publishedVersion, SCHEDULE_QUEUE, triggers, workflows, workflowVersions, type Db } from "@daloy/db";
import { definitionSchema, type Trigger } from "@daloy/engine";
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
import { and, desc, eq, max } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { BOSS, CurrentUser, DB, enqueueRun, isUniqueViolation, ZodPipe, type SessionUser } from "./http";

const workflowInput = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "use a-z, 0-9 and -"),
});
const renameInput = workflowInput.pick({ name: true });
const versionInput = z.object({ definition: z.unknown(), publish: z.boolean().default(false) });
const runInput = z.object({ payload: z.record(z.string(), z.unknown()).default({}) });
const workflowId = new ZodPipe(z.uuid());

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Controller("workflows")
@UseGuards(SessionGuard)
export class WorkflowsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
  ) {}

  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.db.select().from(workflows).where(eq(workflows.userId, user.id)).orderBy(desc(workflows.createdAt));
  }

  @Post()
  async create(@CurrentUser() user: SessionUser, @Body(new ZodPipe(workflowInput)) body: z.output<typeof workflowInput>) {
    try {
      const [wf] = await this.db.insert(workflows).values({ userId: user.id, ...body }).returning();
      return wf;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("slug already in use");
      throw err;
    }
  }

  @Get(":id")
  async get(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string) {
    const wf = await this.owned(user.id, id);
    const [trigger] = await this.db.select().from(triggers).where(eq(triggers.workflowId, id));
    return { ...wf, trigger: trigger ?? null, live: (await publishedVersion(this.db, id)) ?? null };
  }

  @Patch(":id")
  async rename(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string, @Body(new ZodPipe(renameInput)) body: z.output<typeof renameInput>) {
    await this.owned(user.id, id);
    const [wf] = await this.db.update(workflows).set(body).where(eq(workflows.id, id)).returning();
    return wf;
  }

  /** Deletes the workflow with its versions, trigger and run history. */
  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string) {
    await this.owned(user.id, id);
    await this.boss.unschedule(SCHEDULE_QUEUE, id);
    await this.db.delete(workflows).where(eq(workflows.id, id));
  }

  @Get(":id/versions")
  async versions(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string) {
    await this.owned(user.id, id);
    const { version, published, createdAt } = workflowVersions;
    return this.db.select({ id: workflowVersions.id, version, published, createdAt }).from(workflowVersions).where(eq(workflowVersions.workflowId, id)).orderBy(desc(version));
  }

  /** Versions are immutable. Saving adds the next version; publishing also makes it live and syncs its trigger. */
  @Post(":id/versions")
  async addVersion(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string, @Body(new ZodPipe(versionInput)) body: z.output<typeof versionInput>) {
    await this.owned(user.id, id);
    const parsed = definitionSchema.safeParse(body.definition);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join(".") || "definition"}: ${i.message}`));
    const definition = parsed.data;

    // Scheduled first: pg-boss rejects a bad cron here, before anything is saved.
    if (body.publish) await this.syncSchedule(id, definition.trigger);

    try {
      return await this.db.transaction(async (tx) => {
        const [{ latest }] = (await tx.select({ latest: max(workflowVersions.version) }).from(workflowVersions).where(eq(workflowVersions.workflowId, id))) as [{ latest: number | null }];
        const [row] = await tx
          .insert(workflowVersions)
          .values({ workflowId: id, version: (latest ?? 0) + 1, definition, published: body.publish })
          .returning({ id: workflowVersions.id, version: workflowVersions.version, published: workflowVersions.published });
        if (body.publish) await syncTrigger(tx, id, definition.trigger);
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
  @HttpCode(202)
  async run(@CurrentUser() user: SessionUser, @Param("id", workflowId) id: string, @Body(new ZodPipe(runInput)) body: z.output<typeof runInput>) {
    await this.owned(user.id, id);
    const version = await publishedVersion(this.db, id);
    if (!version) throw new ConflictException("publish the workflow first");
    const runId = await createRun(this.db, version.id, body.payload);
    await enqueueRun(this.boss, runId);
    return { id: runId };
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

/** One trigger row per workflow, matching the live version. A webhook keeps its path across publishes so its URL never changes. */
async function syncTrigger(tx: Tx, id: string, trigger: Trigger) {
  const [existing] = await tx.select().from(triggers).where(eq(triggers.workflowId, id));
  const webhookPath = trigger.type === "webhook" ? (existing?.webhookPath ?? randomBytes(32).toString("base64url")) : null;
  const values = { type: trigger.type, config: trigger.config, webhookPath };
  if (existing) await tx.update(triggers).set(values).where(eq(triggers.id, existing.id));
  else await tx.insert(triggers).values({ workflowId: id, ...values });
}
