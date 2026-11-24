import { deleteCustomer, exportCustomer, normalizePhone, type Db } from "@daloy/db";
import { Body, Controller, Get, HttpCode, Inject, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, MANAGE, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";
import { historyHider } from "./mask";

/** R6 (decision 0094): the owner answers a customer's request to see or delete their data. Exactly one of email or phone. */
const email = z.email().max(200);
const phone = z.string().trim().max(40).refine((s) => normalizePhone(s) !== null, "use a Philippine mobile number such as 0917 123 4567");
const who = z.object({ email: email.optional(), phone: phone.optional() }).refine((v) => (v.email === undefined) !== (v.phone === undefined), "give an email or a phone number, not both");
const deleteInput = who.safeExtend({ confirm: z.literal("DELETE", "type DELETE to confirm") });
const query = (v: z.output<typeof who>) => (v.email !== undefined ? { email: v.email } : { phone: v.phone! });

@Controller("privacy")
@UseGuards(SessionGuard, Allow(MANAGE), RateLimit(20))
export class PrivacyController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get("customer")
  async export(@CurrentUser() user: SessionUser, @Query(new ZodPipe(who)) q: z.output<typeof who>, @Res({ passthrough: true }) res: Response) {
    return this.exportBody(user, query(q), res);
  }

  /** L2 fix alongside R6: exports customer data without putting an email or phone in the URL query string. */
  @Post("customer/export")
  @HttpCode(200)
  async exportPost(@CurrentUser() user: SessionUser, @Body(new ZodPipe(who)) q: z.output<typeof who>, @Res({ passthrough: true }) res: Response) {
    return this.exportBody(user, query(q), res);
  }

  private async exportBody(user: SessionUser, q: { email: string } | { phone: string }, res: Response) {
    res.set({ "Content-Disposition": 'attachment; filename="customer-data.json"', "Cache-Control": "no-store" });
    const data = await exportCustomer(this.db, user.workspaceId, user.id, q);
    // The file is handed to the customer, so it hides current and retired workspace secrets like every history reader (review of 22 November, M3).
    // Through JSON first, so dates are text and the hider walks plain values.
    const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
    return hide(JSON.parse(JSON.stringify(data)));
  }

  @Post("customer/delete")
  @HttpCode(200)
  delete(@CurrentUser() user: SessionUser, @Body(new ZodPipe(deleteInput)) body: z.output<typeof deleteInput>) {
    return deleteCustomer(this.db, user.workspaceId, user.id, query(body));
  }
}
