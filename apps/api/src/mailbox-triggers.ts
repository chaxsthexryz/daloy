import { mailboxTriggerStatus, type Db, type MailboxTriggerType } from "@daloy/db";
import { Controller, Get, Header, Inject, Param, Query, UseGuards } from "@nestjs/common";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CurrentUser, DB, OPERATE, RateLimit, ZodPipe, type SessionUser } from "./http";

const statusSchema = z.strictObject({ workflowId: z.uuid().optional() });

/**
 * G3 (decision 0132): what the editor shows under a Gmail or Outlook mailbox trigger. Checks whether the workspace's
 * OAuth grant has read access (gmail.readonly / Mail.Read) and returns the watcher's last status for a saved workflow.
 */
@Controller("triggers/mailbox")
@UseGuards(SessionGuard, Allow(OPERATE))
export class MailboxTriggersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get(":type")
  @Header("Cache-Control", "no-store")
  @UseGuards(RateLimit(30))
  async status(
    @CurrentUser() user: SessionUser,
    @Param("type", new ZodPipe(z.enum(["gmail_message", "outlook_message"]))) type: MailboxTriggerType,
    @Query(new ZodPipe(statusSchema)) q: z.output<typeof statusSchema>,
  ) {
    return mailboxTriggerStatus(this.db, user.workspaceId, type, q.workflowId);
  }
}
