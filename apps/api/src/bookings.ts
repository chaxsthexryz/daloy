import { bookingById, bookingByReference, bookingResults, listBookings, publishedVersion, runs, staffChange, stepRuns, type BookingView, type Db, type StaffResult } from "@daloy/db";
import { bookingStartField, definitionSchema, parseZoned, type WorkflowDefinition } from "@daloy/engine";
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, BOSS, CurrentUser, DB, enqueueRun, OPERATE, ZodPipe, type SessionUser } from "./http";

const CHANGED = "This booking changed since you loaded it. Reload and try again.";
const versionField = z.int().min(1);
export const cancelInput = z.object({ version: versionField });
export const rescheduleInput = z.object({ version: versionField, start: z.string().min(1).max(100) });

type Change = { booking?: BookingView; runId?: string; duplicate?: true };

/** Turns a staff change result into the answer, or the HTTP error that says why not. */
function answer(r: StaffResult): Change {
  if (r.result === "not_found") throw new NotFoundException("booking not found");
  if (r.result === "conflict") throw new ConflictException(CHANGED);
  if (r.result === "taken") throw new ConflictException("That time is taken.");
  return { booking: r.booking, ...(r.runId && { runId: r.runId }), ...(r.result === "duplicate" && { duplicate: true }) };
}

const STEP_REF = /\{\{\s*steps\.([a-z][a-z0-9_]*)/g;

/** The steps that can run after `from`, following every edge. */
function after(def: WorkflowDefinition, from: string): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const e of def.edges) if (e.from === id && !seen.has(e.to)) queue.push((seen.add(e.to), e.to));
  }
  return seen;
}

/**
 * What a staff reschedule needs before it changes anything: the published version must still have the booking step
 * that made this booking (a create whose start is a datetime field), the new time must pass that field's rules, and
 * no step after it may read a step that ran before it, since the new run starts after the booking step and would send
 * that value blank (decision 0032).
 */
async function reschedulePlan(db: Db, booking: { id: string; workflowId: string | null; runId: string | null }, start: string) {
  const [made] = await db.select({ stepId: bookingResults.stepId }).from(bookingResults).where(and(eq(bookingResults.bookingId, booking.id), eq(bookingResults.branch, "done"))).orderBy(asc(bookingResults.createdAt)).limit(1);
  const version = booking.workflowId ? await publishedVersion(db, booking.workflowId) : undefined;
  const def = version ? definitionSchema.parse(version.definition) : undefined;
  const step = def?.steps.find((s) => s.id === made?.stepId);
  const field = step?.type === "booking" && step.config.action === "create" ? bookingStartField(def!.trigger, step.config) : undefined;
  if (!made || !version || !def || !field) throw new ConflictException(`Publish a version with booking step "${made?.stepId ?? "book"}" to reschedule this booking.`);

  const later = after(def, made.stepId);
  for (const s of def.steps.filter((x) => later.has(x.id))) {
    for (const [, read] of JSON.stringify(s.config).matchAll(STEP_REF)) {
      if (read !== made.stepId && !later.has(read!)) throw new ConflictException(`Step "${s.id}" reads step "${read}", which ran before the booking, so a rescheduled run could not fill it in.`);
    }
  }

  const time = parseZoned(start.trim(), { timezone: field.timezone!, slotMinutes: field.slotMinutes });
  if (!time.ok) throw new BadRequestException([`start: ${time.error}`]);
  const [old] = booking.runId ? await db.select({ payload: runs.triggerPayload }).from(runs).where(eq(runs.id, booking.runId)) : [];
  if (!old) throw new ConflictException("The run that made this booking is gone, so it cannot be rescheduled here. Cancel it instead.");
  return { versionId: version.id, stepId: made.stepId, field: field.name, at: time.at, value: time.value, payload: old.payload as Record<string, unknown> };
}

/** Moves a live booking to a new time and starts its one new run, which resumes after the booking step. */
export async function rescheduleBooking(db: Db, boss: PgBoss, workspaceId: string, bookingId: string, version: number, start: string, actor: string): Promise<Change> {
  const booking = await bookingById(db, workspaceId, bookingId);
  if (!booking) throw new NotFoundException("booking not found");
  const plan = await reschedulePlan(db, booking, start);
  const r = await staffChange(
    db,
    {
      workspaceId,
      bookingId,
      version,
      action: "reschedule",
      start: plan.at,
      // In the change's transaction: the run, and its booking step as done with the booking's new times, so later
      // steps read {{steps.<booking step>.output}} as if the step had just booked.
      newRun: async (tx, moved) => {
        const [run] = await tx.insert(runs).values({ workflowVersionId: plan.versionId, triggerPayload: { ...plan.payload, [plan.field]: plan.value } }).returning({ id: runs.id });
        await tx.insert(stepRuns).values({ runId: run!.id, stepId: plan.stepId, attempt: 1, state: "succeeded", branch: "done", input: { action: "reschedule", by: actor }, output: moved, finishedAt: new Date() });
        return run!.id;
      },
    },
    actor,
  );
  const result = answer(r);
  if (r.result === "done" && r.runId) await enqueueRun(boss, r.runId);
  return result;
}

export async function cancelBooking(db: Db, workspaceId: string, bookingId: string, version: number, actor: string): Promise<Change> {
  return answer(await staffChange(db, { workspaceId, bookingId, version, action: "cancel" }, actor));
}

/** Live bookings for staff (decision 0032). Test bookings from the builder are never listed. */
@Controller("bookings")
@UseGuards(SessionGuard, Allow(OPERATE))
export class BookingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
  ) {}

  @Get()
  list(@CurrentUser() user: SessionUser) {
    return listBookings(this.db, user.workspaceId);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string, @Body(new ZodPipe(cancelInput)) body: z.output<typeof cancelInput>) {
    return cancelBooking(this.db, user.workspaceId, id, body.version, `user:${user.id}`);
  }

  @Post(":id/reschedule")
  @HttpCode(200)
  reschedule(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string, @Body(new ZodPipe(rescheduleInput)) body: z.output<typeof rescheduleInput>) {
    return rescheduleBooking(this.db, this.boss, user.workspaceId, id, body.version, body.start, `user:${user.id}`);
  }
}

/** For MCP, which names bookings by reference. */
export async function bookingIdOf(db: Db, workspaceId: string, reference: string) {
  const b = await bookingByReference(db, workspaceId, reference.trim());
  if (!b) throw new NotFoundException("booking not found");
  return b.id;
}
