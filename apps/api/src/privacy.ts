import { deleteCustomer, exportCustomer, normalizePhone, type Db } from "@daloy/db";
import { Body, Controller, Get, HttpCode, Inject, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CurrentUser, DB, MANAGE, RateLimit, ZodPipe, type SessionUser } from "./http";

/** R6 (decision 0094): the owner answers a customer's request to see or delete their data. Exactly one of email or phone. */
const email = z.email().max(200);
const phone = z.string().trim().max(40).refine((s) => normalizePhone(s) !== null, "use a Philippine mobile number such as 0917 123 4567");
const who = z.object({ email: email.optional(), phone: phone.optional() }).refine((v) => (v.email === undefined) !== (v.phone === undefined), "give an email or a phone number, not both");
const deleteInput = who.safeExtend({ confirm: z.literal("DELETE", "type DELETE to confirm") });
const query = (v: z.output<typeof who>) => (v.email !== undefined ? { email: v.email } : { phone: v.phone! });

@Controller("privacy")
@UseGuards(SessionGuard, Allow(MANAGE), RateLimit(20))
export class PrivacyController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("customer")
  async export(@CurrentUser() user: SessionUser, @Query(new ZodPipe(who)) q: z.output<typeof who>, @Res({ passthrough: true }) res: Response) {
    res.set({ "Content-Disposition": 'attachment; filename="customer-data.json"', "Cache-Control": "no-store" });
    return exportCustomer(this.db, user.workspaceId, user.id, query(q));
  }

  @Post("customer/delete")
  @HttpCode(200)
  delete(@CurrentUser() user: SessionUser, @Body(new ZodPipe(deleteInput)) body: z.output<typeof deleteInput>) {
    return deleteCustomer(this.db, user.workspaceId, user.id, query(body));
  }
}
