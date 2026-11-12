import { findPendingApproval, recordDecision, type Db } from "@daloy/db";
import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { BOSS, DB, enqueueRun, RateLimit, ZodPipe } from "./http";
import { escapeHtml, page } from "./public";

const token = new ZodPipe(z.string().regex(/^[A-Za-z0-9_-]{43}$/));
const decisionBody = z.object({ decision: z.enum(["approved", "rejected"]) });

// Unknown, used and expired links all get this, so the page tells an attacker nothing about a token.
const GONE = page("This approval link is not valid. It may have been used already or expired.", "Approval");

/**
 * The public page behind an approval email. GET only shows the request; the decision is recorded on POST,
 * so mail scanners and link previews that fetch the URL cannot approve anything (decision 0009).
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
  async show(@Param("token", token) value: string, @Res({ passthrough: true }) res: Response) {
    const pending = await findPendingApproval(this.db, value);
    if (!pending) {
      res.status(404);
      return GONE;
    }
    const message = String((pending.input as { message?: unknown } | null)?.message ?? "");
    return page(
      `<h1>Approval requested</h1><p style="white-space:pre-wrap">${escapeHtml(message)}</p>` +
        `<form method="post"><button type="submit" name="decision" value="approved">Approve</button> <button type="submit" name="decision" value="rejected">Reject</button></form>`,
      "Approval",
    );
  }

  @Post(":token")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async decide(@Param("token", token) value: string, @Body(new ZodPipe(decisionBody)) body: z.output<typeof decisionBody>, @Res({ passthrough: true }) res: Response) {
    const runId = await recordDecision(this.db, value, body.decision);
    if (!runId) {
      res.status(404);
      return GONE;
    }
    // If this send fails, the worker's sweep still finds the woken run.
    await enqueueRun(this.boss, runId);
    return page(`<p>Thanks. Your answer (${body.decision}) is recorded.</p>`, "Approval");
  }
}
