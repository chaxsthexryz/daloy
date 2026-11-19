import { createHash, randomUUID } from "node:crypto";
import { apiTokens, createKeyedRun, listBookings, resolveRun, runs, stepRuns, triggers, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { payloadSchema, type FormField, type Resource } from "@daloy/engine";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, type AuthInfo, type CallToolResult } from "@modelcontextprotocol/server";
import { All, type CanActivate, Controller, type ExecutionContext, HttpException, Inject, Injectable, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { BOSS, CONFIG, DB, enqueueRun, RateLimit, sha256, type ApiConfig } from "./http";
import { historyHider } from "./mask";
import { isTracked, recordRequest } from "./public";
import { bookingIdOf, cancelBooking, cancelInput, rescheduleBooking, rescheduleInput } from "./bookings";
import { resourcesFor } from "./resources";

// tracked: a guided office or purchase request workflow, whose runs also record a request with a reference.
type ToolRow = { slug: string; name: string; versionId: string; fields: FormField[]; workflowId: string; tracked: boolean };

/** One tool per published form workflow. Slugs use a-z, 0-9 and -, so they never clash with get_run_status. */
/** resources: the workspace's active ones, which a resource field accepts and its description lists (decision 0031). */
export function toolsFromRows(rows: ToolRow[], resources: Resource[] = []) {
  return rows.map((r) => ({
    name: r.slug,
    title: r.name,
    description: `Starts a run of the "${r.name}" workflow with the form fields as input. Returns the run id; check progress with get_run_status.`,
    // idempotencyKey cannot clash with a field: field names are lower case.
    inputSchema: payloadSchema(r.fields, { resources }).extend({ idempotencyKey: z.string().min(1).max(200).optional().describe("Send the same key when retrying a call, so it starts one run") }),
    versionId: r.versionId,
    workflowId: r.workflowId,
    tracked: r.tracked,
  }));
}

type StepRef = { stepId: string; state: string };
/** The run state, except that a run parked on an approval step reports waiting_approval (decision 0009). */
export function runStatus(state: string, last: StepRef | undefined, definition: unknown): string {
  if (state !== "waiting" || last?.state !== "waiting") return state;
  const steps = (definition as { steps?: { id: string; type: string }[] }).steps ?? [];
  return steps.find((s) => s.id === last.stepId)?.type === "approval" ? "waiting_approval" : state;
}

type McpRequest = Request & { auth?: AuthInfo };

/**
 * Bearer API token from the console tokens page. One query looks the token up by its SHA-256, skips revoked and
 * expired tokens and records the use. The owner's id and the token's scopes travel to the tool handlers in authInfo.
 */
@Injectable()
export class McpTokenGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<McpRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const token = /^Bearer (dly_[A-Za-z0-9_-]{1,100})$/.exec(req.headers.authorization ?? "")?.[1];
    const [row] = token
      ? await this.db
          .update(apiTokens)
          .set({ lastUsedAt: sql`now()` })
          .where(and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, sql`now()`))))
          .returning({ id: apiTokens.id, userId: apiTokens.userId, scopes: apiTokens.scopes })
      : [];
    if (!row) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="daloy"');
      throw new UnauthorizedException("missing, unknown, revoked or expired API token");
    }
    req.auth = { token: token!, clientId: row.id, scopes: row.scopes, extra: { userId: row.userId } };
    return true;
  }
}

const result = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const failure = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/**
 * Streamable HTTP endpoint for MCP clients (decision 0011). Stateless: every request gets a fresh McpServer with the
 * caller's tools, so there are no sessions to store and a revoked token stops working on the next request.
 */
@Controller("mcp")
@UseGuards(RateLimit(60), McpTokenGuard)
export class McpController {
  private readonly handle;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {
    this.handle = toNodeHandler(
      createMcpHandler(({ authInfo }) => this.server(String(authInfo?.extra?.userId), authInfo?.scopes ?? []), { onerror: (err) => console.error("mcp", err.message) }),
    );
  }

  @All()
  serve(@Req() req: McpRequest, @Res() res: Response) {
    return this.handle(req, res, req.body);
  }

  /** Tools are registered by the token's scopes, so one it lacks is absent from tools/list and a call to it is an unknown tool. */
  private async server(userId: string, scopes: string[]) {
    const server = new McpServer({ name: "daloy", version: "1.0.0" });
    const rows = scopes.includes("run") ? await this.formWorkflows(userId) : [];
    for (const tool of toolsFromRows(rows, await resourcesFor(this.db, userId, rows.flatMap((r) => r.fields)))) {
      server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema }, async (args) => {
        const { idempotencyKey, ...data } = args as Record<string, unknown> & { idempotencyKey?: string };
        if (tool.tracked) {
          // A retried call with the same key is the same submission; without a key, each call is its own (decision 0029).
          const { runId, reference, existingRunId } = await recordRequest(this.db, { id: tool.workflowId, userId }, tool.versionId, idempotencyKey ? keyUuid(idempotencyKey) : randomUUID(), data);
          if (runId) await enqueueRun(this.boss, runId);
          return result(runId ? { runId, reference, status: "pending" } : { runId: existingRunId, reference, duplicate: true });
        }
        const { runId, duplicate } = await createKeyedRun(this.db, tool.workflowId, tool.versionId, data, idempotencyKey);
        if (!duplicate) await enqueueRun(this.boss, runId);
        return result(duplicate ? { runId, duplicate } : { runId, status: "pending" });
      });
    }
    if (scopes.includes("read")) {
      server.registerTool(
        "get_run_status",
        {
          title: "Get run status",
          description: "Returns the state of a run: pending, running, waiting, waiting_approval, needs_review, succeeded, failed or cancelled.",
          inputSchema: z.object({ runId: z.uuid() }),
        },
        async ({ runId }) => {
          const hide = await historyHider(this.db, this.config.secretsKey, userId);
          const [run] = await this.db
            .select({ state: runs.state, error: runs.error, finishedAt: runs.finishedAt, definition: workflowVersions.definition })
            .from(runs)
            .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
            .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
            .where(and(eq(runs.id, runId), eq(workflows.userId, userId)));
          // Same answer for a run that does not exist and one that belongs to someone else.
          if (!run) return failure("run not found");
          const [last] = await this.db
            .select({ stepId: stepRuns.stepId, state: stepRuns.state })
            .from(stepRuns)
            .where(eq(stepRuns.runId, runId))
            .orderBy(desc(stepRuns.createdAt), desc(stepRuns.attempt))
            .limit(1);
          return result({ runId, status: runStatus(run.state, last, run.definition), error: hide(run.error), finishedAt: run.finishedAt?.toISOString() ?? null });
        },
      );
    }
    if (scopes.includes("manage")) {
      server.registerTool(
        "resolve_run",
        {
          title: "Resolve a run",
          description:
            'Answers a run in needs_review, whose last call may or may not have reached the receiver: "delivered" (it went through; the run continues), "again" (send it once more with the same Idempotency-Key; a receiver that does not deduplicate may get it twice) or "stop" (cancel the run). "retry" gives a failed run one more attempt of its failed step.',
          inputSchema: z.object({ runId: z.uuid(), action: z.enum(["delivered", "again", "stop", "retry"]) }),
        },
        async ({ runId, action }) => {
          const [me] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId));
          // One guarded update: of two callers acting at once only one acts. Someone else's run looks like a missing one.
          if (!(await resolveRun(this.db, userId, runId, action, `${me?.email ?? userId} (MCP)`))) return failure("run not found, or not in a state this action applies to");
          if (action !== "stop") await enqueueRun(this.boss, runId);
          return result({ runId, action, status: action === "stop" ? "cancelled" : "running" });
        },
      );
    }
    // Live bookings only; builder test bookings never show here (decision 0032). Errors keep the API's wording.
    const asTool = async (work: () => Promise<Record<string, unknown>>) => {
      try {
        return result(await work());
      } catch (err) {
        if (err instanceof HttpException) {
          const m = (err.getResponse() as { message?: string | string[] }).message ?? err.message;
          return failure(Array.isArray(m) ? m.join("; ") : m);
        }
        throw err;
      }
    };
    if (scopes.includes("read")) {
      server.registerTool(
        "list_bookings",
        { title: "List bookings", description: "Lists the workspace's bookings with reference, resource, start and end in the booking's timezone, status and version. Pass the version to cancel_booking or reschedule_booking.", inputSchema: z.object({}) },
        async () => asTool(async () => ({ bookings: (await listBookings(this.db, userId)).map(({ reference, resource, start, end, timezone, status, version, attention }) => ({ reference, resource, start, end, timezone, status, version, attention })) })),
      );
    }
    if (scopes.includes("manage")) {
      server.registerTool(
        "cancel_booking",
        { title: "Cancel a booking", description: "Cancels a booking. version is the version you last saw; a repeat of the same call gets the same answer.", inputSchema: z.object({ reference: z.string().min(1).max(30), version: cancelInput.shape.version }) },
        async ({ reference, version }) => asTool(async () => cancelBooking(this.db, userId, await bookingIdOf(this.db, userId, reference), version, "mcp")),
      );
      server.registerTool(
        "reschedule_booking",
        {
          title: "Reschedule a booking",
          description: "Moves a booking to a new start time, checked like the booking form's time field (written like 2027-01-20T14:00 in the booking's timezone, or with an offset). Starts one new run for the new time; the old reminders stop. version is the version you last saw.",
          inputSchema: z.object({ reference: z.string().min(1).max(30), version: rescheduleInput.shape.version, start: rescheduleInput.shape.start }),
        },
        async ({ reference, version, start }) => asTool(async () => rescheduleBooking(this.db, this.boss, userId, await bookingIdOf(this.db, userId, reference), version, start, "mcp")),
      );
    }
    return server;
  }

  /** The owner's workflows with a form trigger and at least one published version, with the latest published one. */
  private async formWorkflows(userId: string): Promise<ToolRow[]> {
    const rows = await this.db
      .selectDistinctOn([workflows.id], { workflowId: workflows.id, slug: workflows.slug, name: workflows.name, setup: workflows.setup, versionId: workflowVersions.id, config: triggers.config })
      .from(workflows)
      .innerJoin(triggers, and(eq(triggers.workflowId, workflows.id), eq(triggers.type, "form")))
      .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, workflows.id), eq(workflowVersions.published, true)))
      .where(eq(workflows.userId, userId))
      .orderBy(workflows.id, desc(workflowVersions.version));
    return rows.map(({ config, setup, ...r }) => ({
      ...r,
      fields: (config as { fields: FormField[] }).fields,
      tracked: isTracked(setup),
    }));
  }
}

/** requests.submission_key is a uuid, so a caller's key becomes one: the same key always gives the same uuid. */
const keyUuid = (key: string) => {
  const h = createHash("sha256").update(`mcp:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
