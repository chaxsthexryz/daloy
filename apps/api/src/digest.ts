import { users, type Db } from "@daloy/db";
import { Body, Controller, Get, Inject, Put, UseGuards } from "@nestjs/common";
import { eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CurrentUser, DB, MANAGE, ZodPipe, type SessionUser } from "./http";

const input = z.strictObject({ enabled: z.boolean() });

/** R5, decision 0092: the owner turns the morning digest on or off. It is off by default and is emailed to the owner's login address only. */
@Controller("settings/digest")
@UseGuards(SessionGuard, Allow(MANAGE))
export class DigestController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async read(@CurrentUser() user: SessionUser) {
    const [row] = await this.db.select({ enabled: users.digestEnabled }).from(users).where(eq(users.id, user.workspaceId));
    return { enabled: row?.enabled ?? false };
  }

  @Put()
  async update(@CurrentUser() user: SessionUser, @Body(new ZodPipe(input)) body: z.output<typeof input>) {
    await this.db.update(users).set({ digestEnabled: body.enabled }).where(eq(users.id, user.workspaceId));
    return { enabled: body.enabled };
  }
}
