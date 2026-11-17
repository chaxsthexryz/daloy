import { users, type Db } from "@daloy/db";
import { LANGUAGES } from "@daloy/engine";
import { Body, Controller, Inject, Put, UseGuards } from "@nestjs/common";
import { eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CurrentUser, DB, MANAGE, ZodPipe, type SessionUser } from "./http";

const input = z.strictObject({ language: z.enum(LANGUAGES) });

@Controller("settings/language")
@UseGuards(SessionGuard, Allow(MANAGE))
export class LanguageController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Put()
  async update(@CurrentUser() user: SessionUser, @Body(new ZodPipe(input)) body: z.output<typeof input>) {
    await this.db.update(users).set({ language: body.language }).where(eq(users.id, user.workspaceId));
    return { language: body.language };
  }
}
