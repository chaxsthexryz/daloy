import {
  connections,
  deliveries,
  listPendingApprovals,
  mailSenders,
  requests,
  runs,
  workflows,
  workflowVersions,
  type Db,
} from "@daloy/db";
import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { and, desc, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { CONFIG, CurrentUser, DB, ZodPipe, type ApiConfig, type SessionUser } from "./http";
import { loadInboxData } from "./inbox";

export const homeTzSchema = z
  .string()
  .max(80)
  .default("Asia/Manila")
  .refine((v) => {
    try {
      Intl.DateTimeFormat("en-US", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, "not a valid time zone");

const PROVIDER_NAMES: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  google_sheets: "Google Sheets",
  google_calendar: "Google Calendar",
  google_drive: "Google Drive",
  slack: "Slack",
  teams: "Microsoft Teams",
  telegram: "Telegram",
  discord: "Discord",
  paymongo: "PayMongo",
  airtable: "Airtable",
  notion: "Notion",
  trello: "Trello",
  meta_messenger: "Facebook Messenger & Instagram",
  whatsapp: "WhatsApp Cloud API",
  shopify: "Shopify",
};

export type HomeProblem = {
  id: string;
  kind: "run" | "connection" | "schedule";
  title: string;
  detail: string;
  href: string;
  createdAt: string;
};

export type HomeRunningWorkflow = {
  id: string;
  name: string;
  runsToday: number;
  lastRunAt: string | null;
  lastState: string | null;
};

export type HomePayload = {
  role: SessionUser["role"];
  needsYou: { total: number; conversations: number; receipts: number; approvals: number; runs: number };
  problems: HomeProblem[];
  running: HomeRunningWorkflow[];
  recentRuns: {
    id: string;
    workflowId: string;
    workflowName: string;
    reference: string | null;
    state: string;
    test: boolean;
    live: boolean;
    needsReview: boolean;
    deliveryFailed: boolean;
    error: string | null;
    createdAt: string;
    finishedAt: string | null;
  }[];
};

/**
 * G5 Today Home: summarizes Needs you (exact parity with GET /inbox), Problems,
 * running automations and recent activity in one endpoint. Approvers/requesters see only
 * their own pending approval count and zero workspace runs/connections.
 */
@Controller("home")
@UseGuards(SessionGuard)
export class HomeController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  @Get()
  async summary(
    @CurrentUser() user: SessionUser,
    @Query("tz", new ZodPipe(homeTzSchema)) tz: string,
  ): Promise<HomePayload> {
    if (user.role === "approver" || user.role === "requester") {
      const approvalsCount =
        user.role === "approver"
          ? (await listPendingApprovals(this.db, user.workspaceId)).filter((a) => a.approverId === user.id).length
          : 0;
      return {
        role: user.role,
        needsYou: {
          total: approvalsCount,
          conversations: 0,
          receipts: 0,
          approvals: approvalsCount,
          runs: 0,
        },
        problems: [],
        running: [],
        recentRuns: [],
      };
    }

    const deliveryFailed = sql<boolean>`exists (select 1 from ${deliveries} where ${deliveries.runId} = ${runs.id} and ${deliveries.state} = 'failed')`;
    const deliveryInReview = sql<boolean>`exists (select 1 from ${deliveries} where ${deliveries.runId} = ${runs.id} and ${deliveries.state} = 'needs_review')`;
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const livePublished = sql<boolean>`exists (select 1 from ${workflowVersions} where ${workflowVersions.workflowId} = ${workflows.id} and ${workflowVersions.published})`;

    const [inbox, failedRunRows, failedConns, failedSender, missedSchedules, liveWorkflows, todayCounts, newestRuns, recentRunRows] =
      await Promise.all([
        loadInboxData(this.db, this.config.secretsKey, user),
        this.db
          .select({
            id: runs.id,
            workflowName: workflows.name,
            reference: requests.reference,
            error: runs.error,
            createdAt: runs.createdAt,
          })
          .from(runs)
          .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
          .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
          .leftJoin(requests, eq(requests.runId, runs.id))
          .where(
            and(
              eq(workflows.userId, user.workspaceId),
              eq(runs.test, false),
              gte(runs.createdAt, sevenDaysAgo),
              or(eq(runs.state, "failed"), deliveryFailed),
            ),
          )
          .orderBy(desc(runs.createdAt))
          .limit(10),
        this.db
          .select({
            provider: connections.provider,
            lastError: connections.lastError,
            updatedAt: connections.updatedAt,
          })
          .from(connections)
          .where(and(eq(connections.userId, user.workspaceId), eq(connections.status, "failed"))),
        this.db
          .select({
            lastError: mailSenders.lastError,
            updatedAt: mailSenders.updatedAt,
          })
          .from(mailSenders)
          .where(and(eq(mailSenders.userId, user.workspaceId), eq(mailSenders.status, "failed"))),
        this.db
          .select({
            id: workflows.id,
            name: workflows.name,
            scheduleMissedAt: workflows.scheduleMissedAt,
          })
          .from(workflows)
          .where(and(eq(workflows.userId, user.workspaceId), isNotNull(workflows.scheduleMissedAt))),
        this.db
          .select({ id: workflows.id, name: workflows.name })
          .from(workflows)
          .where(and(eq(workflows.userId, user.workspaceId), livePublished, isNull(workflows.pausedAt)))
          .orderBy(desc(workflows.createdAt)),
        this.db
          .select({
            workflowId: workflowVersions.workflowId,
            total: sql<number>`count(*)`.mapWith(Number),
          })
          .from(runs)
          .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
          .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
          .where(
            and(
              eq(workflows.userId, user.workspaceId),
              eq(runs.test, false),
              sql`(${runs.createdAt} at time zone ${tz})::date = (now() at time zone ${tz})::date`,
            ),
          )
          .groupBy(workflowVersions.workflowId),
        this.db
          .selectDistinctOn([workflowVersions.workflowId], {
            workflowId: workflowVersions.workflowId,
            state: runs.state,
            createdAt: runs.createdAt,
          })
          .from(runs)
          .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
          .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
          .where(and(eq(workflows.userId, user.workspaceId), eq(runs.test, false)))
          .orderBy(workflowVersions.workflowId, desc(runs.createdAt)),
        this.db
          .select({
            id: runs.id,
            workflowId: workflows.id,
            workflowName: workflows.name,
            reference: requests.reference,
            state: runs.state,
            test: runs.test,
            live: runs.live,
            needsReview: sql<boolean>`(${runs.state} = 'needs_review' or ${deliveryInReview})`,
            deliveryFailed,
            error: runs.error,
            createdAt: runs.createdAt,
            finishedAt: runs.finishedAt,
          })
          .from(runs)
          .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
          .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
          .leftJoin(requests, eq(requests.runId, runs.id))
          .where(eq(workflows.userId, user.workspaceId))
          .orderBy(desc(runs.createdAt))
          .limit(20),
      ]);

    const problems: HomeProblem[] = [
      ...failedRunRows.map((r): HomeProblem => ({
        id: `run:${r.id}`,
        kind: "run",
        title: r.reference ? `${r.workflowName} · ${r.reference}` : r.workflowName,
        detail: r.error || "Run failed",
        href: `#/runs/${r.id}`,
        createdAt: r.createdAt.toISOString(),
      })),
      ...failedConns.map((c): HomeProblem => ({
        id: `conn:${c.provider}`,
        kind: "connection",
        title: `${PROVIDER_NAMES[c.provider] ?? c.provider} needs attention`,
        detail: c.lastError || "Reconnect in Business > Apps",
        href: `#/business?tab=apps&app=${c.provider.replaceAll("_", "-")}`,
        createdAt: c.updatedAt.toISOString(),
      })),
      ...failedSender.map((s): HomeProblem => ({
        id: "conn:gmail",
        kind: "connection",
        title: "Gmail needs attention",
        detail: s.lastError || "Reconnect in Business > Apps",
        href: "#/business?tab=apps&app=gmail",
        createdAt: s.updatedAt.toISOString(),
      })),
      ...missedSchedules.map((w): HomeProblem => ({
        id: `sched:${w.id}`,
        kind: "schedule",
        title: `${w.name} missed a scheduled run`,
        detail: "Check schedule and readiness",
        href: `#/a/${w.id}`,
        createdAt: w.scheduleMissedAt!.toISOString(),
      })),
    ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const countByWorkflow = new Map(todayCounts.map((row) => [row.workflowId, row.total]));
    const lastByWorkflow = new Map(newestRuns.map((row) => [row.workflowId, row]));

    const running: HomeRunningWorkflow[] = liveWorkflows.map((w) => {
      const last = lastByWorkflow.get(w.id);
      return {
        id: w.id,
        name: w.name,
        runsToday: countByWorkflow.get(w.id) ?? 0,
        lastRunAt: last ? last.createdAt.toISOString() : null,
        lastState: last ? last.state : null,
      };
    });

    return {
      role: user.role,
      needsYou: inbox.counts,
      problems,
      running,
      recentRuns: recentRunRows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      })),
    };
  }
}
