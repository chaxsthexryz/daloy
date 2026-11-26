import {
  CAN_APPROVE,
  decideApprovalById,
  deliveries,
  listConversations,
  listPendingApprovals,
  requests,
  reviewList,
  runs,
  workflows,
  workflowVersions,
  type ApprovalDecision,
  type Db,
} from "@daloy/db";
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, BOSS, CONFIG, CurrentUser, DB, enqueueRun, OPERATE, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";
import { historyHider } from "./mask";

export const decideInboxApprovalBody = z.object({ decision: z.enum(["approved", "rejected"]) });

export type InboxKind = "conversation" | "receipt" | "approval" | "run";

export type InboxItem =
  | {
      id: string;
      kind: "conversation";
      title: string;
      subtitle: string;
      createdAt: string;
      data: Awaited<ReturnType<typeof listConversations>>[number];
    }
  | {
      id: string;
      kind: "receipt";
      title: string;
      subtitle: string;
      createdAt: string;
      data: Omit<Awaited<ReturnType<typeof reviewList>>[number], "createdAt"> & { createdAt: string };
    }
  | {
      id: string;
      kind: "approval";
      title: string;
      subtitle: string;
      createdAt: string;
      data: {
        id: string;
        runId: string;
        workflowId: string;
        workflowName: string;
        reference: string | null;
        stepId: string;
        message: string;
        approverId: string | null;
        approverEmail: string | null;
        canDecide: boolean;
        expiresAt: string;
        createdAt: string;
      };
    }
  | {
      id: string;
      kind: "run";
      title: string;
      subtitle: string;
      createdAt: string;
      data: {
        id: string;
        workflowId: string;
        workflowName: string;
        reference: string | null;
        state: string;
        deliveryNeedsReview: boolean;
        error: string | null;
        createdAt: string;
      };
    };

export type InboxPayload = {
  counts: { total: number; conversations: number; receipts: number; approvals: number; runs: number };
  items: InboxItem[];
};

const channelName = (channel: string) =>
  channel === "messenger"
    ? "Messenger"
    : channel === "instagram"
      ? "Instagram"
      : channel === "telegram"
        ? "Telegram"
        : channel === "whatsapp"
          ? "WhatsApp"
          : "Email";

/**
 * Loads every pending person-action item in a workspace for both GET /inbox and GET /home
 * so Home's "Needs you" card and the Inbox sidebar badge read one source of truth.
 */
export async function loadInboxData(
  db: Db,
  secretsKey: Buffer,
  actor: Pick<SessionUser, "id" | "role" | "workspaceId">,
): Promise<InboxPayload> {
  const deliveryInReview = sql<boolean>`exists (select 1 from ${deliveries} where ${deliveries.runId} = ${runs.id} and ${deliveries.state} = 'needs_review')`;

  const [allConvos, receipts, pendingApprovals, reviewRuns, hide] = await Promise.all([
    listConversations(db, actor.workspaceId),
    reviewList(db, actor.workspaceId),
    listPendingApprovals(db, actor.workspaceId),
    db
      .select({
        id: runs.id,
        workflowId: workflows.id,
        workflowName: workflows.name,
        reference: requests.reference,
        state: runs.state,
        deliveryNeedsReview: deliveryInReview,
        error: runs.error,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .leftJoin(requests, eq(requests.runId, runs.id))
      .where(and(eq(workflows.userId, actor.workspaceId), eq(runs.test, false), or(eq(runs.state, "needs_review"), deliveryInReview)))
      .orderBy(asc(runs.createdAt))
      .limit(50),
    historyHider(db, secretsKey, actor.workspaceId),
  ]);

  const waitingConvos = allConvos.filter((c) => c.paused || c.status === "staff");
  const canApproveRole = CAN_APPROVE.includes(actor.role);

  const items: InboxItem[] = [
    ...waitingConvos.map((c): InboxItem => ({
      id: `conversation:${c.id}`,
      kind: "conversation",
      title: c.fields.name?.trim() || (c.channel === "email" ? c.externalId : `${channelName(c.channel)} guest`),
      subtitle: `${channelName(c.channel)}${c.latestMessage ? ` · ${c.latestMessage.text}` : ""}`,
      createdAt: c.lastInboundAt ?? c.createdAt,
      data: c,
    })),
    ...receipts.map((r): InboxItem => ({
      id: `receipt:${r.claimId ?? r.dueId}`,
      kind: "receipt",
      title: r.reference,
      subtitle: r.type === "reply" ? "Reply failed after confirmation" : `PHP ${(r.amountDue / 100).toFixed(2)}`,
      createdAt: r.createdAt.toISOString(),
      data: { ...r, createdAt: r.createdAt.toISOString() },
    })),
    ...pendingApprovals.map((a): InboxItem => {
      const masked = hide(a.input) as { message?: unknown } | null;
      const message = String(masked?.message ?? "");
      const canDecide = !a.approverId || (a.approverId === actor.id && canApproveRole);
      return {
        id: `approval:${a.id}`,
        kind: "approval",
        title: a.reference ? `${a.workflowName} · ${a.reference}` : a.workflowName,
        subtitle: message || "Approval requested",
        createdAt: a.createdAt.toISOString(),
        data: {
          id: a.id,
          runId: a.runId,
          workflowId: a.workflowId,
          workflowName: a.workflowName,
          reference: a.reference,
          stepId: a.stepId,
          message,
          approverId: a.approverId,
          approverEmail: a.approverEmail,
          canDecide,
          expiresAt: a.expiresAt.toISOString(),
          createdAt: a.createdAt.toISOString(),
        },
      };
    }),
    ...reviewRuns.map((r): InboxItem => ({
      id: `run:${r.id}`,
      kind: "run",
      title: r.reference ? `${r.workflowName} · ${r.reference}` : r.workflowName,
      subtitle: r.error || "Check before sending again",
      createdAt: r.createdAt.toISOString(),
      data: { ...r, createdAt: r.createdAt.toISOString() },
    })),
  ].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const counts = {
    total: items.length,
    conversations: waitingConvos.length,
    receipts: receipts.length,
    approvals: pendingApprovals.length,
    runs: reviewRuns.length,
  };
  return { counts, items };
}

/**
 * G4 unified Inbox: one queue for Conversations needing staff, Receipts to review,
 * pending workflow Approvals, and Needs-check runs.
 */
@Controller("inbox")
@UseGuards(SessionGuard, Allow(OPERATE))
export class InboxController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  @Get()
  list(@CurrentUser() user: SessionUser) {
    return loadInboxData(this.db, this.config.secretsKey, user);
  }

  @Post("approvals/:id/decide")
  @HttpCode(200)
  @UseGuards(RateLimit(20))
  async decideApproval(
    @CurrentUser() user: SessionUser,
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @Body(new ZodPipe(decideInboxApprovalBody)) body: { decision: ApprovalDecision },
  ) {
    const res = await decideApprovalById(this.db, {
      workspaceId: user.workspaceId,
      approvalId: id,
      decision: body.decision,
      actor: { id: user.id, email: user.email },
    });
    if (!res.ok) {
      if (res.reason === "not_found") throw new NotFoundException("Approval not found.");
      if (res.reason === "forbidden") throw new ForbiddenException("This approval is assigned to another team member.");
      throw new ConflictException("This approval was already answered or expired.");
    }
    await enqueueRun(this.boss, res.runId);
    return { ok: true, runId: res.runId, decision: body.decision };
  }
}
