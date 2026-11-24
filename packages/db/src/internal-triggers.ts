import { definitionSchema, parsePayload } from "@daloy/engine";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index";
import { centavosToPesos } from "./paymongo";
import { createKeyedRun, publishedVersion, WorkflowPausedError } from "./runs";
import { bookings, resources, triggers, workflows } from "./schema";

export const MAX_SUB_WORKFLOW_DEPTH = 3;

export type BookingTriggerEvent = "created" | "rescheduled" | "cancelled";
export type PaymentTriggerEvent = "confirmed" | "expired";

export function bookingEventPayload(
  event: BookingTriggerEvent,
  booking: {
    id?: string;
    reference?: string;
    resource?: { id?: string; name?: string };
    start?: string;
    end?: string;
    minutes?: number;
    timezone?: string;
    status?: string;
    version?: number;
    nights?: number;
    checkIn?: string;
    checkOut?: string;
    conversationId?: string;
  },
): Record<string, unknown> {
  return {
    event,
    bookingId: booking.id,
    reference: booking.reference,
    resourceId: booking.resource?.id,
    resourceName: booking.resource?.name,
    start: booking.start,
    end: booking.end,
    minutes: booking.minutes,
    timezone: booking.timezone,
    status: booking.status,
    version: booking.version,
    ...(booking.nights !== undefined
      ? { mode: "stay", nights: booking.nights, checkIn: booking.checkIn, checkOut: booking.checkOut }
      : { mode: "slot" }),
    ...(booking.conversationId ? { conversationId: booking.conversationId } : {}),
  };
}

export function paymentEventPayload(
  event: PaymentTriggerEvent,
  due: { id: string; reference: string; kind: string; status: string; amountCentavos: number; bookingId?: string | null },
  conversationId?: string | null,
): Record<string, unknown> {
  return {
    event,
    dueId: due.id,
    reference: due.reference,
    kind: due.kind,
    status: due.status,
    amountCentavos: due.amountCentavos,
    amountPesos: centavosToPesos(due.amountCentavos),
    ...(due.bookingId ? { bookingId: due.bookingId } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

/** Optional lookup so payment_event payloads carry conversationId when a linked booking has one. */
export async function dueConversationId(db: Db, bookingId: string | null | undefined): Promise<string | undefined> {
  if (!bookingId) return undefined;
  const [row] = await db.select({ conversationId: bookings.conversationId }).from(bookings).where(eq(bookings.id, bookingId));
  return row?.conversationId ?? undefined;
}

export type InternalTriggerDispatch = {
  /** Automations whose runs led to this event, oldest first. An event from outside Daloy has none (decision 0128). */
  callChain?: string[];
} & (
  | {
      workspaceId: string;
      type: "booking_event";
      event: BookingTriggerEvent;
      eventKey: string;
      payload: Record<string, unknown>;
    }
  | {
      workspaceId: string;
      type: "payment_event";
      event: PaymentTriggerEvent;
      eventKey: string;
      payload: Record<string, unknown>;
    });

/**
 * Starts one keyed run for each live, unpaused workflow in `workspaceId` subscribed to this internal
 * Daloy event (`booking_event` or `payment_event`). Duplicate `eventKey` values return no new run id.
 * A listener already in `callChain` is skipped and nothing starts past MAX_SUB_WORKFLOW_DEPTH, so an automation
 * whose own steps raise the event it listens to cannot start itself again and again (decision 0128).
 */
export async function dispatchInternalTrigger(db: Db, input: InternalTriggerDispatch): Promise<{ runIds: string[] }> {
  const rows = await db
    .select({ workflowId: triggers.workflowId, pausedAt: workflows.pausedAt })
    .from(triggers)
    .innerJoin(workflows, eq(workflows.id, triggers.workflowId))
    .where(and(eq(workflows.userId, input.workspaceId), eq(triggers.type, input.type)));

  const chain = input.callChain ?? [];
  const runIds: string[] = [];
  if (chain.length >= MAX_SUB_WORKFLOW_DEPTH) return { runIds };
  for (const row of rows) {
    if (row.pausedAt || chain.includes(row.workflowId)) continue;
    const version = await publishedVersion(db, row.workflowId);
    if (!version) continue;
    const parsed = definitionSchema.safeParse(version.definition);
    if (!parsed.success || parsed.data.trigger.type !== input.type) continue;
    const events: readonly string[] = parsed.data.trigger.config.events;
    if (!events.includes(input.event)) continue;

    try {
      const res = await createKeyedRun(db, row.workflowId, version.id, { ...input.payload, _callChain: [...chain, row.workflowId] }, input.eventKey);
      if (!res.duplicate) runIds.push(res.runId);
    } catch (err) {
      if (err instanceof WorkflowPausedError) continue;
      throw err;
    }
  }
  return { runIds };
}

export type SubWorkflowInput = {
  workspaceId: string;
  workflowSlug: string;
  eventKey: string;
  payload: Record<string, unknown>;
  callChain: string[];
};

export type SubWorkflowResult = {
  runId: string;
  duplicate: boolean;
  workflowId: string;
  workflowSlug: string;
};

/**
 * Starts one keyed child run for a published `sub_workflow` in the same workspace, enforcing
 * pause state, cycle rejection, depth limit (MAX_SUB_WORKFLOW_DEPTH), and trigger field schema checks.
 */
export async function startSubWorkflow(db: Db, input: SubWorkflowInput): Promise<SubWorkflowResult> {
  const [wf] = await db
    .select({ id: workflows.id, slug: workflows.slug, pausedAt: workflows.pausedAt })
    .from(workflows)
    .where(and(eq(workflows.userId, input.workspaceId), eq(workflows.slug, input.workflowSlug)))
    .limit(1);
  if (!wf) throw new Error(`No automation with slug "${input.workflowSlug}" exists in this workspace.`);
  if (wf.pausedAt) throw new WorkflowPausedError();

  const version = await publishedVersion(db, wf.id);
  if (!version) throw new Error(`Automation "${input.workflowSlug}" has no published version.`);

  const parsedDef = definitionSchema.safeParse(version.definition);
  if (!parsedDef.success || parsedDef.data.trigger.type !== "sub_workflow") {
    throw new Error(`Automation "${input.workflowSlug}" does not start with "Called by another automation".`);
  }
  if (input.callChain.includes(wf.id)) {
    throw new Error(`Calling "${input.workflowSlug}" would create a loop.`);
  }
  if (input.callChain.length >= MAX_SUB_WORKFLOW_DEPTH) {
    throw new Error(`Nested automation depth limit (${MAX_SUB_WORKFLOW_DEPTH}) reached.`);
  }

  let data: Record<string, unknown> = input.payload;
  const fields = parsedDef.data.trigger.config.fields;
  if (fields) {
    const needsResources = fields.some((f) => f.type === "resource");
    const activeResources = needsResources
      ? await db
          .select({ id: resources.id, name: resources.name })
          .from(resources)
          .where(and(eq(resources.userId, input.workspaceId), eq(resources.active, true)))
      : undefined;
    const checked = parsePayload(fields, input.payload, {
      ...(activeResources ? { resources: activeResources } : {}),
      now: Date.now(),
    });
    if (!checked.ok) {
      throw new Error(`Invalid inputs for "${input.workflowSlug}": ${checked.errors.join("; ")}`);
    }
    data = checked.data;
  }

  const childPayload = { ...data, _callChain: [...input.callChain, wf.id] };
  const started = await createKeyedRun(db, wf.id, version.id, childPayload, input.eventKey);
  return {
    runId: started.runId,
    duplicate: Boolean(started.duplicate),
    workflowId: wf.id,
    workflowSlug: wf.slug,
  };
}
