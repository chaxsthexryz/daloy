import { ensureCalendar, ProviderError, type Db } from "@daloy/db";
import { BadRequestException, Body, Controller, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, MANAGE, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";

const input = z.strictObject({ again: z.boolean().default(false) });

/**
 * Easy connect for Calendar after a Google sign-in (decision 0064). Daloy normally makes its calendar right after
 * consent; this route is for when that failed, or when the owner deleted the calendar in Google Calendar and wants a new one.
 */
@Controller("settings/connections")
@UseGuards(SessionGuard, Allow(MANAGE))
export class GoogleCalendarController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  @Post("google-calendar/create")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async create(@CurrentUser() user: SessionUser, @Body(new ZodPipe(input)) body: z.output<typeof input>) {
    return ensureCalendar(this.db, this.config.secretsKey, this.config.providers, user.workspaceId, body).catch((err: unknown) => {
      if (err instanceof ProviderError) throw new BadRequestException(err.message);
      throw err;
    });
  }
}
