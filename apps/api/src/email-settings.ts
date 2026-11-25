import { randomUUID } from "node:crypto";
import {
  claimVerifyToken,
  verifyLinkStatus,
  connectGmail,
  disconnectOAuth,
  gmail,
  isLocalCatcher,
  issueVerifyToken,
  type Mailer,
  mailSenders,
  markSenderWorking,
  readProfile,
  readSender,
  removeGmail,
  saveProfile,
  sendAs,
  sharedMailAllowed,
  type Db,
} from "@daloy/db";
import { builtInEmailCopy, gmailInput, profileInput } from "@daloy/engine";
import { BadRequestException, Body, ConflictException, GoneException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Post, Put, Res, UseGuards } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Response } from "express";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, RateLimit, ZodPipe, type ApiConfig, type SessionUser, MANAGE } from "./http";
import { historyHider } from "./mask";

const verifyInput = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
/** Heuristic: the installation server is a local catcher (Mailpit, localhost), judged by host name only. */
export const installationLocal = (m: Mailer) => isLocalCatcher(m.host);
const addressOf = (from: string | { address: string }) => (typeof from === "string" ? (/<([^>]+)>/.exec(from)?.[1] ?? from) : from.address);

/** The owner's business profile and their own Gmail sender (roadmap phase 2, decision 0020). The app password is write-only. */
@Controller("settings/email")
@UseGuards(SessionGuard, Allow(MANAGE))
export class EmailSettingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  @Get()
  async get(@CurrentUser() user: SessionUser) {
    const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
    const sender = await readSender(this.db, user.workspaceId);
    const local = installationLocal(this.config.mail.installation);
    const allowed = await sharedMailAllowed(this.db, this.config.mail, user.workspaceId);
    return {
      profile: await readProfile(this.db, user.workspaceId),
      sender: sender ? { ...sender, lastError: hide(sender.lastError) as string | null } : null,
      // Only shown for local development mailers when permitted; never expose an operator's email address.
      installationFrom: local && allowed ? addressOf(this.config.mail.installation.from) : null,
      // False when the shared server only sends for approved owners and this one is not approved (decision 0024).
      installationAllowed: allowed,
      installationLocal: local,
      signInEmail: user.email,
    };
  }

  @Put("profile")
  @HttpCode(204)
  async putProfile(@CurrentUser() user: SessionUser, @Body(new ZodPipe(profileInput)) body: z.output<typeof profileInput>) {
    await saveProfile(this.db, user.workspaceId, body);
  }

  /** Connect, Reconnect and Replace password. A new address must be confirmed again before mail goes out. */
  @Put("gmail")
  async putGmail(@CurrentUser() user: SessionUser, @Body(new ZodPipe(gmailInput)) body: z.output<typeof gmailInput>) {
    await connectGmail(this.db, this.config.secretsKey, user.workspaceId, body);
    const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
    const sender = await readSender(this.db, user.workspaceId);
    return sender ? { ...sender, lastError: hide(sender.lastError) as string | null } : null;
  }

  /**
   * "Send a test email to me": to the Gmail address itself, or to the sign-in email through the installation server.
   * An unconfirmed Gmail sender's test carries the one-time link. ok: true means the mail server accepted the message,
   * which is not the same as the owner seeing it in their inbox.
   */
  @Post("test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async test(@CurrentUser() user: SessionUser) {
    const sender = await readSender(this.db, user.workspaceId);
    if (sender?.status === "disconnected") return { ok: false, error: "Gmail is disconnected. Connect it again first." };
    const to = sender?.address ?? user.email;
    const needsConfirmation = !!sender && !sender.verifiedAt;
    const copy = builtInEmailCopy(user.language);
    const lines = [copy.testBody as string];
    if (needsConfirmation) {
      const token = await issueVerifyToken(this.db, user.workspaceId);
      lines.push(
        "",
        copy.verify,
        `${this.config.publicUrl}/#/verify-sender/${token}`,
        "",
        copy.verifyExpiry,
      );
    }
    try {
      // The Gmail API and Google client for a Google sign-in (decision 0063): the API's own provider URLs unless the mailer has them.
      const mail = { ...this.config.mail, urls: this.config.mail.urls ?? this.config.providers };
      const sent = await sendAs(this.db, this.config.secretsKey, mail, user.workspaceId, { to, subject: copy.testSubject, text: lines.join("\n") }, `test:${randomUUID()}`, {
        allowUnconfirmed: true,
      });
      if (sent.gmail) await markSenderWorking(this.db, user.workspaceId);
      const replyTo = (await readProfile(this.db, user.workspaceId))?.replyTo ?? undefined;
      return { ok: true, to, from: sent.from, ...(replyTo ? { replyTo } : {}), gmail: sent.gmail, needsConfirmation };
    } catch (err) {
      const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
      return { ok: false, error: hide(err instanceof Error ? err.message : String(err)) as string };
    }
  }

  // Keep the token in the body and out of request URLs, including the read-only preview.
  @Post("verify/status")
  @HttpCode(200)
  @UseGuards(RateLimit(30))
  async verifyStatus(@CurrentUser() user: SessionUser, @Body(new ZodPipe(verifyInput)) body: z.output<typeof verifyInput>) {
    return verifyLinkStatus(this.db, user.workspaceId, body.token);
  }

  /** Claims the link from the test email. Only the signed-in owner it was sent to can use it, once, within 30 minutes. */
  @Post("verify")
  @HttpCode(204)
  @UseGuards(RateLimit(10))
  async verify(@CurrentUser() user: SessionUser, @Body(new ZodPipe(verifyInput)) body: z.output<typeof verifyInput>) {
    if (!(await claimVerifyToken(this.db, user.workspaceId, body.token))) {
      const { state } = await verifyLinkStatus(this.db, user.workspaceId, body.token);
      if (state === "used") throw new ConflictException("This link has already been used.");
      if (state === "expired") throw new GoneException("This link has expired.");
      throw new BadRequestException("This link is unavailable. Send a new test email.");
    }
  }

  /**
   * Deletes the app password or the Google sign-in. Mail from this owner's automations stops until they reconnect;
   * nothing is sent another way. A Google sign-in is then revoked at Google (decision 0063): 200 with { revoked }.
   */
  @Post("disconnect")
  async disconnect(@CurrentUser() user: SessionUser, @Res({ passthrough: true }) res: Response) {
    const out = await disconnectOAuth(this.db, this.config.secretsKey, this.config.providers, user.workspaceId, gmail);
    if (!out.removed) throw new NotFoundException();
    res.status(out.revoked === null ? 204 : 200);
    return out.revoked === null ? undefined : { revoked: out.revoked };
  }

  /** "Use the local mail server instead": the owner's explicit choice to send through the installation server again. */
  @Delete("gmail")
  @HttpCode(204)
  async remove(@CurrentUser() user: SessionUser) {
    const [row] = await this.db.select({ authMethod: mailSenders.authMethod, connected: mailSenders.passwordCiphertext }).from(mailSenders).where(eq(mailSenders.userId, user.workspaceId));
    if (!row) throw new NotFoundException();
    // A Google sign-in still held is revoked first, so choosing the local server leaves no grant behind at Google.
    if (row.authMethod === "oauth" && row.connected) await disconnectOAuth(this.db, this.config.secretsKey, this.config.providers, user.workspaceId, gmail);
    await removeGmail(this.db, user.workspaceId);
  }
}
