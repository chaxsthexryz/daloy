import { CAN_APPROVE, findPendingApproval, recordDecision, type Db } from "@daloy/db";
import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { sessionUser } from "./auth";
import { BOSS, DB, enqueueRun, RateLimit, ZodPipe, type SessionUser } from "./http";
import { escapeHtml, page } from "./public";

const token = new ZodPipe(z.string().regex(/^[A-Za-z0-9_-]{43}$/));
const decisionBody = z.object({ decision: z.enum(["approved", "rejected"]) });

// Unknown, used and expired links all get this, so the page tells an attacker nothing about a token.
const GONE = page("This approval link is not valid. It may have been used already or expired.", "Approval");
// A named approval opened by someone else. It says nothing about the request: its details are private.
const NOT_YOURS = page("<h1>Approval requested</h1><p>This approval is assigned to someone else. Only the person it names can answer it.</p>", "Approval");
// The console's #/answer route signs the visitor in and comes back here. The token is checked against a strict pattern there.
const signIn = (value: string) =>
  page(`<h1>Approval requested</h1><p>This approval is for a named person. Sign in to see it and answer.</p><p><a href="/#/answer/${value}">Sign in</a></p>`, "Approval");

type Pending = NonNullable<Awaited<ReturnType<typeof findPendingApproval>>>;
type Access = { ok: true; user: SessionUser | null } | { ok: false; status: 401 | 403; html: string };

/**
 * The public page behind an approval email. GET only shows the request; the decision is recorded on POST,
 * so mail scanners and link previews that fetch the URL cannot approve anything (decision 0009). A named approval
 * also needs its approver signed in (decision 0022): the check here picks the page to show, and recordDecision
 * repeats it in the database, where it is the one that counts.
 */
@Controller("approvals")
export class ApprovalsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: PgBoss,
  ) {}

  @Get(":token")
  @UseGuards(RateLimit(30))
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async show(@Param("token", token) value: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const pending = await findPendingApproval(this.db, value);
    if (!pending) {
      res.status(404);
      return GONE;
    }
    const access = await this.access(pending, value, req);
    if (!access.ok) {
      res.status(access.status);
      return access.html;
    }
    const message = String((pending.input as { message?: unknown } | null)?.message ?? "");
    const who = access.user ? `<p class="muted">Signed in as ${escapeHtml(access.user.email)}</p>` : "";
    return page(
      `<h1>Approval requested</h1>${who}<p style="white-space:pre-wrap">${escapeHtml(message)}</p>` +
        `<form method="post"><button type="submit" name="decision" value="approved">Approve</button> <button type="submit" name="decision" value="rejected">Reject</button></form>`,
      "Approval",
    );
  }

  @Post(":token")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async decide(
    @Param("token", token) value: string,
    @Body(new ZodPipe(decisionBody)) body: z.output<typeof decisionBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await sessionUser(this.db, req);
    const runId = await recordDecision(this.db, value, body.decision, user ?? undefined);
    if (!runId) {
      // Nothing was recorded. If the link is still live, it was the wrong person; otherwise it is used or expired.
      const pending = await findPendingApproval(this.db, value);
      const access = pending && (await this.access(pending, value, req));
      if (access && !access.ok) {
        res.status(access.status);
        return access.html;
      }
      res.status(404);
      return GONE;
    }
    // If this send fails, the worker's sweep still finds the woken run.
    await enqueueRun(this.boss, runId);
    return page(`<p>Thanks. Your answer (${body.decision}) is recorded.</p>`, "Approval");
  }

  private async access(pending: Pending, value: string, req: Request): Promise<Access> {
    if (!pending.approverId) return { ok: true, user: null };
    const user = await sessionUser(this.db, req);
    if (!user) return { ok: false, status: 401, html: signIn(value) };
    const mayAnswer = user.id === pending.approverId && user.workspaceId === pending.workspaceId && CAN_APPROVE.includes(user.role);
    return mayAnswer ? { ok: true, user } : { ok: false, status: 403, html: NOT_YOURS };
  }
}
