import {
  conversationDetail,
  conversationPayload,
  conversationSettings,
  createRun,
  deleteCustomer,
  exportCustomer,
  findDepositWorkflow,
  handBackConversation,
  listConversations,
  saveConversationSettings,
  sendStaffAlert,
  staffAlertStatus,
  takeOverConversation,
  updateConversationFields,
  type Db,
} from "@daloy/db";
import { Body, ConflictException, Controller, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Post, Put, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, BOSS, CONFIG, CurrentUser, DB, enqueueRun, MANAGE, OPERATE, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";
import { historyHider } from "./mask";

const fieldsInput = z.object({
  check_in: z.string().max(200).optional(),
  check_out: z.string().max(200).optional(),
  guests: z.string().max(200).optional(),
  name: z.string().max(200).optional(),
  phone: z.string().max(200).optional(),
  email: z.string().max(200).optional(),
});

const settingsInput = z.object({
  conversationRetentionDays: z.int().min(1).max(3650).optional(),
  staffQuietHours: z.int().min(1).max(168).optional(),
  staffAlertPsid: z.string().trim().max(64).nullable().optional(),
});

const depositInput = z.object({
  workflowId: z.uuid().optional(),
  room: z.string().trim().min(1).max(200).optional(),
  resource: z.string().trim().min(1).max(200).optional(),
  checkIn: z.string().trim().min(1).max(40).optional(),
  nights: z.coerce.number().int().min(1).max(30).optional(),
  guests: z.coerce.number().int().min(1).max(100).optional(),
});

const alertInput = z.object({
  reason: z.string().trim().max(200).optional(),
});

const deleteInput = z.object({
  confirm: z.literal("DELETE", "type DELETE to confirm"),
});

/**
 * C7 Conversations inbox and staff alerts (decision 0125).
 * Owners and operators review messages, take over / hand back, edit gathered fields, confirm stays,
 * and trigger deposit requests. Only owners adjust retention/alert settings or export/delete a guest.
 */
@Controller("conversations")
@UseGuards(SessionGuard, Allow(OPERATE))
export class ConversationsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async list(@CurrentUser() user: SessionUser) {
    const [items, alertStatus, settings] = await Promise.all([
      listConversations(this.db, user.workspaceId),
      staffAlertStatus(this.db, user.workspaceId),
      user.role === "owner" ? conversationSettings(this.db, user.workspaceId) : Promise.resolve(undefined),
    ]);
    return { conversations: items, alertStatus, ...(settings ? { settings } : {}) };
  }

  @Put("settings")
  @UseGuards(Allow(MANAGE))
  async updateSettings(@CurrentUser() user: SessionUser, @Body(new ZodPipe(settingsInput)) body: z.output<typeof settingsInput>) {
    const settings = await saveConversationSettings(this.db, user.workspaceId, body);
    if (!settings) throw new NotFoundException("workspace not found");
    const alertStatus = await staffAlertStatus(this.db, user.workspaceId);
    return { settings, alertStatus };
  }

  @Get(":id")
  async detail(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    const d = await conversationDetail(this.db, user.workspaceId, id);
    if (!d) throw new NotFoundException("conversation not found");
    return d;
  }

  @Post(":id/take-over")
  @HttpCode(200)
  async takeOver(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    const updated = await takeOverConversation(this.db, user.workspaceId, id);
    if (!updated) throw new NotFoundException("conversation not found");
    return { status: updated.status, paused: true };
  }

  @Post(":id/hand-back")
  @HttpCode(200)
  async handBack(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    const updated = await handBackConversation(this.db, user.workspaceId, id);
    if (!updated) throw new NotFoundException("conversation not found");
    return { status: updated.status, paused: false };
  }

  @Put(":id/fields")
  async saveFields(
    @CurrentUser() user: SessionUser,
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @Body(new ZodPipe(fieldsInput)) body: z.output<typeof fieldsInput>,
  ) {
    const updated = await updateConversationFields(this.db, user.workspaceId, id, body);
    if (!updated) throw new NotFoundException("conversation not found");
    return { fields: updated.fields };
  }

  @Post(":id/alert")
  @UseGuards(RateLimit(20))
  @HttpCode(200)
  async sendAlert(
    @CurrentUser() user: SessionUser,
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @Body(new ZodPipe(alertInput)) body: z.output<typeof alertInput>,
  ) {
    const detail = await conversationDetail(this.db, user.workspaceId, id);
    if (!detail) throw new NotFoundException("conversation not found");
    return sendStaffAlert(
      { db: this.db, secretsKey: this.config.secretsKey, mail: this.config.mail!, urls: this.config.providers, publicUrl: this.config.publicUrl },
      { workspaceId: user.workspaceId, conversationId: id, reason: body.reason },
    );
  }

  @Post(":id/deposit-request")
  @HttpCode(HttpStatus.ACCEPTED)
  async depositRequest(
    @CurrentUser() user: SessionUser,
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @Body(new ZodPipe(depositInput)) body: z.output<typeof depositInput>,
  ) {
    const detail = await conversationDetail(this.db, user.workspaceId, id);
    if (!detail) throw new NotFoundException("conversation not found");

    const wf = await findDepositWorkflow(this.db, user.workspaceId, body.workflowId);
    if (!wf) {
      throw new ConflictException("Publish a Deposit and stay workflow (with a payment request step) first.");
    }

    const convoSummary = await conversationPayload(this.db, { id: detail.id, status: detail.status, fields: detail.fields, openDueId: detail.openDueId });
    const resource = body.resource ?? body.room;
    const email = detail.fields.email ?? (detail.channel === "email" ? detail.externalId : undefined);
    const payload: Record<string, unknown> = {
      ...detail.fields,
      ...(email ? { email } : {}),
      ...(body.room ? { room: body.room } : {}),
      ...(resource ? { resource } : {}),
      ...(body.checkIn ? { check_in: body.checkIn } : detail.fields.check_in ? { check_in: detail.fields.check_in } : {}),
      ...(body.nights !== undefined ? { nights: String(body.nights) } : {}),
      ...(body.guests !== undefined ? { guests: String(body.guests) } : detail.fields.guests ? { guests: detail.fields.guests } : {}),
      conversation_id: detail.id,
      channel: detail.channel,
      senderId: detail.channel === "messenger" || detail.channel === "instagram" ? detail.externalId : "",
      conversation: convoSummary,
    };

    const runId = await createRun(this.db, wf.versionId, payload, {
      conversationId: detail.id,
    });
    await enqueueRun(this.boss, runId);
    return { runId, workflowId: wf.workflowId };
  }

  @Post(":id/export")
  @UseGuards(Allow(MANAGE), RateLimit(20))
  @HttpCode(200)
  async exportGuest(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string, @Res({ passthrough: true }) res: Response) {
    const detail = await conversationDetail(this.db, user.workspaceId, id);
    if (!detail) throw new NotFoundException("conversation not found");
    res.set({ "Content-Disposition": 'attachment; filename="guest-conversation-data.json"', "Cache-Control": "no-store" });
    const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
    const data = await exportCustomer(this.db, user.workspaceId, user.id, { conversationId: id }, { hide });
    return hide(JSON.parse(JSON.stringify(data)));
  }

  @Post(":id/delete")
  @UseGuards(Allow(MANAGE), RateLimit(20))
  @HttpCode(200)
  async deleteGuest(
    @CurrentUser() user: SessionUser,
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @Body(new ZodPipe(deleteInput)) _body: z.output<typeof deleteInput>,
  ) {
    void _body;
    const detail = await conversationDetail(this.db, user.workspaceId, id);
    if (!detail) throw new NotFoundException("conversation not found");
    return deleteCustomer(this.db, user.workspaceId, user.id, { conversationId: id });
  }
}
