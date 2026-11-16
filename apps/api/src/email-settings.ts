import { randomUUID } from "node:crypto";
import {
  claimVerifyToken,
  connectGmail,
  disconnectGmail,
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
import { gmailInput, profileInput } from "@daloy/engine";
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Post, Put, UseGuards } from "@nestjs/common";
import { eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, RateLimit, ZodPipe, type ApiConfig, type SessionUser, MANAGE } from "./http";

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
    return {
      profile: await readProfile(this.db, user.workspaceId),
      sender: await readSender(this.db, user.workspaceId),
      // Shown when no Gmail is connected, so the owner knows which address their mail comes from.
      installationFrom: addressOf(this.config.mail.installation.from),
      // False when the shared server only sends for approved owners and this one is not approved (decision 0024).
      installationAllowed: await sharedMailAllowed(this.db, this.config.mail, user.workspaceId),
      installationLocal: installationLocal(this.config.mail.installation),
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
    return readSender(this.db, user.workspaceId);
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
    const lines = ["This is a test email from Daloy. Mail from your automations will look like this."];
    if (needsConfirmation) {
      const token = await issueVerifyToken(this.db, user.workspaceId);
      lines.push(
        "",
        "To start sending your automations' email from this address, open this link while you are signed in to Daloy:",
        `${this.config.publicUrl}/#/verify-sender/${token}`,
        "",
        "The link works once and expires in 30 minutes.",
      );
    }
    try {
      const sent = await sendAs(this.db, this.config.secretsKey, this.config.mail, user.workspaceId, { to, subject: "Daloy test email", text: lines.join("\n") }, `test:${randomUUID()}`, {
        allowUnconfirmed: true,
      });
      if (sent.gmail) await markSenderWorking(this.db, user.workspaceId);
      const replyTo = (await readProfile(this.db, user.workspaceId))?.replyTo ?? undefined;
      return { ok: true, to, from: sent.from, ...(replyTo ? { replyTo } : {}), gmail: sent.gmail, needsConfirmation };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Claims the link from the test email. Only the signed-in owner it was sent to can use it, once, within 30 minutes. */
  @Post("verify")
  @HttpCode(204)
  @UseGuards(RateLimit(10))
  async verify(@CurrentUser() user: SessionUser, @Body(new ZodPipe(verifyInput)) body: z.output<typeof verifyInput>) {
    if (!(await claimVerifyToken(this.db, user.workspaceId, body.token))) {
      throw new BadRequestException("This link was used already, has expired, or belongs to another account. Send a new test email.");
    }
  }

  /** Deletes the app password. Mail from this owner's automations stops until they reconnect; nothing is sent another way. */
  @Post("disconnect")
  @HttpCode(204)
  async disconnect(@CurrentUser() user: SessionUser) {
    if (!(await readSender(this.db, user.workspaceId))) throw new NotFoundException();
    await disconnectGmail(this.db, user.workspaceId);
  }

  /** "Use the local mail server instead": the owner's explicit choice to send through the installation server again. */
  @Delete("gmail")
  @HttpCode(204)
  async remove(@CurrentUser() user: SessionUser) {
    const [row] = await this.db.select({ userId: mailSenders.userId }).from(mailSenders).where(eq(mailSenders.userId, user.workspaceId));
    if (!row) throw new NotFoundException();
    await removeGmail(this.db, user.workspaceId);
  }
}
