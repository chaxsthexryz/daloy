import { usageSummary, type Db } from "@daloy/db";
import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { SessionGuard } from "./auth";
import { Allow, CurrentUser, DB, OPERATE, type SessionUser } from "./http";

/** The plan, its limits and what the office has used, for the console's usage notices. */
@Controller("usage")
@UseGuards(SessionGuard, Allow(OPERATE))
export class UsageController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  get(@CurrentUser() user: SessionUser) {
    return usageSummary(this.db, user.workspaceId);
  }
}
