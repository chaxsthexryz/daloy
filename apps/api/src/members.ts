import { createInviteRecord, listMembers, listPendingInvites, reissueInvite, removeMember, requests, revokeInvite, ROLES, runs, setMemberRole, users, workflows, workspaceMembers, type Db } from "@daloy/db";
import { Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, ANY_MEMBER, CONFIG, CurrentUser, DB, MANAGE, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";
import { historyHider } from "./mask";

const memberRole = z.enum(ROLES.filter((r) => r !== "owner") as ["operator", "approver", "requester"]);
const inviteInput = z.object({ email: z.email().max(254).transform((s) => s.toLowerCase()), role: memberRole });
const roleInput = z.object({ role: memberRole });
const userId = new ZodPipe(z.uuid());

/** The owner's Team page: members, roles and invite links (decision 0022). The owner row itself can't be changed. */
@Controller("workspace")
@UseGuards(SessionGuard)
export class MembersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get("members")
  @UseGuards(Allow(MANAGE))
  members(@CurrentUser() user: SessionUser) {
    return listMembers(this.db, user.workspaceId);
  }

  @Get("invites")
  @UseGuards(Allow(MANAGE))
  pendingInvites(@CurrentUser() user: SessionUser) {
    return listPendingInvites(this.db, user.workspaceId);
  }

  /** Returns a one-time link for the owner to send; nothing is emailed. It expires after seven days. */
  @Post("invites")
  @UseGuards(Allow(MANAGE), RateLimit(20))
  async invite(@CurrentUser() user: SessionUser, @Body(new ZodPipe(inviteInput)) body: z.output<typeof inviteInput>) {
    const [already] = await this.db
      .select({ id: users.id })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, user.workspaceId), eq(users.email, body.email)));
    if (already) throw new ConflictException("this person is already a member");
    const created = await createInviteRecord(this.db, user.workspaceId, body.email, body.role);
    return {
      id: created.id,
      email: created.email,
      role: created.role,
      link: `${this.config.publicUrl}/#/invite/${created.token}`,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
    };
  }

  /** Rotates the token for a pending invite so the owner can copy a fresh one-time link. */
  @Post("invites/:id/reissue")
  @HttpCode(200)
  @UseGuards(Allow(MANAGE), RateLimit(20))
  async reissue(@CurrentUser() user: SessionUser, @Param("id", userId) id: string) {
    const next = await reissueInvite(this.db, user.workspaceId, id);
    if (!next) throw new NotFoundException();
    return {
      id: next.id,
      email: next.email,
      role: next.role,
      link: `${this.config.publicUrl}/#/invite/${next.token}`,
      createdAt: next.createdAt,
      expiresAt: next.expiresAt,
    };
  }

  @Delete("invites/:id")
  @HttpCode(204)
  @UseGuards(Allow(MANAGE))
  async revoke(@CurrentUser() user: SessionUser, @Param("id", userId) id: string) {
    if (!(await revokeInvite(this.db, user.workspaceId, id))) throw new NotFoundException();
  }

  @Patch("members/:userId")
  @HttpCode(204)
  @UseGuards(Allow(MANAGE))
  async setRole(@CurrentUser() user: SessionUser, @Param("userId", userId) id: string, @Body(new ZodPipe(roleInput)) body: z.output<typeof roleInput>) {
    if (!(await setMemberRole(this.db, user.workspaceId, id, body.role))) throw new NotFoundException();
  }

  /** Signs the member out everywhere. Named approvals waiting for them can no longer be answered. */
  @Delete("members/:userId")
  @HttpCode(204)
  @UseGuards(Allow(MANAGE))
  async remove(@CurrentUser() user: SessionUser, @Param("userId", userId) id: string) {
    if (!(await removeMember(this.db, user.workspaceId, id))) throw new NotFoundException();
  }
}

/** Requests the signed-in member sent through a form while signed in. Every role has this. */
@Controller("my")
@UseGuards(SessionGuard, Allow(ANY_MEMBER))
export class MyRequestsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get("requests")
  async mine(@CurrentUser() user: SessionUser) {
    const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
    const rows = await this.db
      .select({ reference: requests.reference, subject: requests.subject, createdAt: requests.createdAt, automation: workflows.name, state: runs.state })
      .from(requests)
      .innerJoin(workflows, eq(workflows.id, requests.workflowId))
      .innerJoin(runs, eq(runs.id, requests.runId))
      .where(and(eq(requests.requestedBy, user.id), eq(requests.userId, user.workspaceId)))
      .orderBy(desc(requests.createdAt))
      .limit(100);
    return rows.map((r) => ({ ...r, subject: hide(r.subject) as string }));
  }
}
