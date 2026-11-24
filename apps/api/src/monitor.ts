import { monitorTriggerStatus, usageSummary, type Db } from "@daloy/db";
import { Controller, Get, Header, Inject, Query, UseGuards } from "@nestjs/common";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CurrentUser, DB, OPERATE, RateLimit, ZodPipe, type SessionUser } from "./http";

const querySchema = z.strictObject({ workflowId: z.uuid().optional() });

/**
 * G4 (decision 0133): what the editor shows under a `page_changed` trigger:
 * watcher status (`trigger_polls`) and today's remaining web request allowance.
 */
@Controller("triggers/monitor")
@UseGuards(SessionGuard, Allow(OPERATE))
export class MonitorTriggersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @UseGuards(RateLimit(30))
  async status(@CurrentUser() user: SessionUser, @Query(new ZodPipe(querySchema)) q: z.output<typeof querySchema>) {
    const [status, usage] = await Promise.all([
      monitorTriggerStatus(this.db, user.workspaceId, q.workflowId),
      usageSummary(this.db, user.workspaceId),
    ]);
    return { ...status, http: usage.http };
  }
}
