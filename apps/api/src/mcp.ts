import { apiTokens, createRun, runs, stepRuns, triggers, workflows, workflowVersions, type Db } from "@daloy/db";
import type { FormField } from "@daloy/engine";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, type AuthInfo, type CallToolResult } from "@modelcontextprotocol/server";
import { All, type CanActivate, Controller, type ExecutionContext, Inject, Injectable, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { BOSS, DB, enqueueRun, RateLimit, sha256 } from "./http";
import { fieldsSchema } from "./public";

type ToolRow = { slug: string; name: string; versionId: string; fields: FormField[] };

/** One tool per published form workflow. Slugs use a-z, 0-9 and -, so they never clash with get_run_status. */
export function toolsFromRows(rows: ToolRow[]) {
  return rows.map((r) => ({
    name: r.slug,
    title: r.name,
    description: `Starts a run of the "${r.name}" workflow with the form fields as input. Returns the run id; check progress with get_run_status.`,
    inputSchema: fieldsSchema(r.fields),
    versionId: r.versionId,
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
 * Bearer API token from the console tokens page. One query looks the token up by its SHA-256, skips revoked
 * tokens and records the use. The owner's id travels to the tool handlers in authInfo.
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
          .where(and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt)))
          .returning({ id: apiTokens.id, userId: apiTokens.userId })
      : [];
    if (!row) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="daloy"');
      throw new UnauthorizedException("missing, unknown or revoked API token");
    }
    req.auth = { token: token!, clientId: row.id, scopes: [], extra: { userId: row.userId } };
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
  ) {
    this.handle = toNodeHandler(
      createMcpHandler(({ authInfo }) => this.server(String(authInfo?.extra?.userId)), { onerror: (err) => console.error("mcp", err.message) }),
    );
  }

  @All()
  serve(@Req() req: McpRequest, @Res() res: Response) {
    return this.handle(req, res, req.body);
  }

  private async server(userId: string) {
    const server = new McpServer({ name: "daloy", version: "1.0.0" });
    for (const tool of toolsFromRows(await this.formWorkflows(userId))) {
      server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema }, async (args) => {
        const runId = await createRun(this.db, tool.versionId, args);
        await enqueueRun(this.boss, runId);
        return result({ runId, status: "pending" });
      });
    }
    server.registerTool(
      "get_run_status",
      {
        title: "Get run status",
        description: "Returns the state of a run: pending, running, waiting, waiting_approval, succeeded, failed or cancelled.",
        inputSchema: z.object({ runId: z.uuid() }),
      },
      async ({ runId }) => {
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
        return result({ runId, status: runStatus(run.state, last, run.definition), error: run.error, finishedAt: run.finishedAt?.toISOString() ?? null });
      },
    );
    return server;
  }

  /** The owner's workflows with a form trigger and at least one published version, with the latest published one. */
  private async formWorkflows(userId: string): Promise<ToolRow[]> {
    const rows = await this.db
      .selectDistinctOn([workflows.id], { slug: workflows.slug, name: workflows.name, versionId: workflowVersions.id, config: triggers.config })
      .from(workflows)
      .innerJoin(triggers, and(eq(triggers.workflowId, workflows.id), eq(triggers.type, "form")))
      .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, workflows.id), eq(workflowVersions.published, true)))
      .where(eq(workflows.userId, userId))
      .orderBy(workflows.id, desc(workflowVersions.version));
    return rows.map(({ config, ...r }) => ({ ...r, fields: (config as { fields: FormField[] }).fields }));
  }
}
