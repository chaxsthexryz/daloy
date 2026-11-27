import { publicCopy } from "./public-copy";
import { workspaceLanguage, CAN_APPROVE, findPendingApproval, recordDecision, type Db } from "@daloy/db";
import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { OwnOriginGuard, sessionUser } from "./auth";
import { BOSS, CONFIG, DB, enqueueRun, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";
import { historyHider } from "./mask";
import { escapeHtml, pageBrand, type PageBrand } from "./public";
import { approvalShell } from "./public-pages";

const token = new ZodPipe(z.string().regex(/^[A-Za-z0-9_-]{43}$/));
const decisionBody = z.object({ decision: z.enum(["approved", "rejected"]) });

type Language = "en" | "tl";
const card = (language: Language, brand: PageBrand | undefined, heading: string | undefined, body: string) => approvalShell({ title: publicCopy[language].approval, heading, body, language, brand, eyebrow: publicCopy[language].approval });
// Unknown, used and expired links all get this, so the page tells an attacker nothing about a token. It has no workspace, so it carries no brand.
const gone = (language: Language = "en") => card(language, undefined, publicCopy[language].invalidTitle, `<span class="pill no">${publicCopy[language].invalidPill}</span><p class="lead">${publicCopy[language].invalid}</p>`);
const GONE = gone();
// A named approval opened by someone else. It says nothing about the request: its details are private.
const notYours = (language: Language, brand?: PageBrand) => card(language, brand, publicCopy[language].requested, `<span class="pill">${publicCopy[language].notYoursPill}</span><p class="lead">${publicCopy[language].notYours}</p>`);
// The console's #/answer route signs the visitor in and comes back here. The token is checked against a strict pattern there.
const signIn = (value: string, language: Language, brand?: PageBrand) => card(language, brand, publicCopy[language].requested, `<p class="lead">${publicCopy[language].named}</p><p><a class="btn" href="/#/answer/${value}">${publicCopy[language].signIn}</a></p>`);

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
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  @Get(":token")
  @UseGuards(RateLimit(30))
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  // Helmet's no-referrer makes the form post with `Origin: null`, which OwnOriginGuard refuses. same-origin sends
  // the real Origin to this page's own form and still keeps the link token out of referrers to other sites (decision 0128).
  @Header("Referrer-Policy", "same-origin")
  async show(@Param("token", token) value: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // One REPEATABLE READ snapshot for both the approval input and retired secrets, so a concurrent purge cannot remove a retired secret between the two reads.
    const snapshot = await this.db.transaction(
      async (tx) => {
        const pending = await findPendingApproval(tx, value);
        if (!pending) return null;
        const hide = await historyHider(tx, this.config.secretsKey, pending.workspaceId);
        return { pending, hide };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (!snapshot) {
      res.status(404);
      return GONE;
    }
    const { pending, hide } = snapshot;
    const access = await this.access(pending, value, req);
    if (!access.ok) {
      res.status(access.status);
      return access.html;
    }
    const language = await workspaceLanguage(this.db, pending.workspaceId);
    const copy = publicCopy[language];
    const brand = await pageBrand(this.db, pending.workspaceId);
    const input = hide(pending.input) as { message?: unknown } | null;
    const message = String(input?.message ?? "");
    const who = access.user ? `<p class="muted">${copy.signedIn} ${escapeHtml(access.user.displayName ?? access.user.email)}</p>` : "";
    return card(
      language,
      brand,
      copy.requested,
      `${who}<div class="msg">${escapeHtml(message)}</div>` +
        `<form method="post" class="actions"><button class="btn" type="submit" name="decision" value="approved">${copy.approve}</button><button class="btn ghost" type="submit" name="decision" value="rejected">${copy.reject}</button></form><p class="muted">${copy.decisionNote}</p>`,
    );
  }

  @Post(":token")
  @HttpCode(200)
  @UseGuards(OwnOriginGuard, RateLimit(10))
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async decide(
    @Param("token", token) value: string,
    @Body(new ZodPipe(decisionBody)) body: z.output<typeof decisionBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await sessionUser(this.db, req);
    // Read the workspace before recordDecision consumes the token.
    const pendingBefore = await findPendingApproval(this.db, value);
    const language = pendingBefore ? await workspaceLanguage(this.db, pendingBefore.workspaceId) : "en";
    const copy = publicCopy[language];
    const brand = pendingBefore ? await pageBrand(this.db, pendingBefore.workspaceId) : undefined;
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
    const pill = body.decision === "approved" ? `<span class="pill ok">${copy.approvedPill}</span>` : `<span class="pill no">${copy.rejectedPill}</span>`;
    return card(language, brand, undefined, `${pill}<p>${copy.recorded} (${copy[body.decision]}) ${copy.recordedEnd}</p>`);
  }

  private async access(pending: Pending, value: string, req: Request): Promise<Access> {
    const language = await workspaceLanguage(this.db, pending.workspaceId);
    const brand = await pageBrand(this.db, pending.workspaceId);
    if (!pending.approverId) return { ok: true, user: null };
    const user = await sessionUser(this.db, req);
    if (!user) return { ok: false, status: 401, html: signIn(value, language, brand) };
    const mayAnswer = user.id === pending.approverId && user.workspaceId === pending.workspaceId && CAN_APPROVE.includes(user.role);
    return mayAnswer ? { ok: true, user } : { ok: false, status: 403, html: notYours(language, brand) };
  }
}
