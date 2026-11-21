import { randomBytes } from "node:crypto";
import { claimInvite, joinWorkspace, manilaDay, membershipOf, passwordResets, sessions, users, workspaceLanguage, workspaceMembers, type Db } from "@daloy/db";
import { builtInEmailCopy } from "@daloy/engine";
import {
  BadRequestException,
  Body,
  type CanActivate,
  ConflictException,
  Controller,
  ForbiddenException,
  type ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Request, Response } from "express";
import * as z from "zod";
import { CONFIG, CurrentUser, DB, isUniqueViolation, RateLimit, sha256, ZodPipe, type ApiConfig, type SessionUser } from "./http";

const COOKIE = "daloy_session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
// Sign-ups per client IP per hour. The test suites raise it, since every account there comes from 127.0.0.1.
const REGISTER_LIMIT = Number(process.env.REGISTER_LIMIT_PER_HOUR || 10);
if (!Number.isInteger(REGISTER_LIMIT) || REGISTER_LIMIT < 1) throw new Error("REGISTER_LIMIT_PER_HOUR must be a whole number above 0");
// Invite accepts per client IP per minute. Raised in e2e for the same reason as REGISTER_LIMIT.
const ACCEPT_LIMIT = Number(process.env.INVITE_ACCEPT_LIMIT_PER_MINUTE || 10);
if (!Number.isInteger(ACCEPT_LIMIT) || ACCEPT_LIMIT < 1) throw new Error("INVITE_ACCEPT_LIMIT_PER_MINUTE must be a whole number above 0");

const email = z.email().max(254).transform((s) => s.toLowerCase());
const registerInput = z.object({ email, password: z.string().min(12).max(200) });
const loginInput = z.object({ email, password: z.string().min(1).max(200) });
// A new account needs the same 12 characters as register; an existing one checks its own password.
const acceptInput = z.object({ password: z.string().min(12).max(200) });
const changePasswordInput = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12).max(200) });
const resetRequestInput = z.object({ email });
const RESET_MS = 30 * 60_000;
// Mails per account per hour, so one address cannot be flooded from many IPs.
const RESETS_PER_HOUR = 3;
const inviteToken = new ZodPipe(z.string().regex(/^[A-Za-z0-9_-]{43}$/));

/**
 * The user behind the session cookie, with their workspace and role, or null. An account that is in no workspace
 * (a removed member) counts as signed out (decision 0022).
 */
export async function sessionUser(db: Db, req: Request): Promise<SessionUser | null> {
  const token: unknown = req.cookies?.[COOKIE];
  if (typeof token !== "string" || token.length > 100) return null;
  const owner = alias(users, "workspace_owner");
  const [user] = await db
    .select({ id: users.id, email: users.email, workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role, language: owner.language })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .innerJoin(owner, eq(owner.id, workspaceMembers.workspaceId))
    .where(and(eq(sessions.idHash, sha256(token)), gt(sessions.expiresAt, sql`now()`)));
  return user ?? null;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = await sessionUser(this.db, req);
    if (!user) throw new UnauthorizedException();
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !fromOwnOrigin(req, this.config.publicUrl)) throw new ForbiddenException("this change must be made from the Daloy page itself");
    req.user = user;
    return true;
  }
}

/**
 * False when a browser sent this request from some other origin. SameSite=Lax still sends the cookie from a sibling
 * origin of the same site, and a plain form post can carry a urlencoded body the API parses, so a signed-in change
 * must come from this installation's page. Own origin means PUBLIC_URL, or the host the request itself was sent to
 * (a LAN address, the Vite dev server). A request with no Origin header is not from a browser page and passes.
 */
function fromOwnOrigin(req: Request, publicUrl: string | undefined): boolean {
  const origin = req.get("origin");
  if (origin === undefined) return true;
  try {
    const { origin: normalised } = new URL(origin);
    const host = req.get("host");
    return normalised === new URL(publicUrl ?? "http://localhost:3000").origin || (!!host && normalised === `${req.protocol}://${host}`);
  } catch {
    return false;
  }
}

// New accounts start on the preview plan until the operator sets a real one; SIGNUP_PLAN=none keeps them unlimited (decision 0057).
const signupPlan = () => (process.env.SIGNUP_PLAN === "none" ? {} : { plan: "preview", planStartedOn: manilaDay() });

// Checked when the email is unknown, so a missing account takes as long to reject as a wrong password.
let dummyHash: Promise<string> | undefined;

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post("register")
  @UseGuards(RateLimit(REGISTER_LIMIT, 60 * 60_000))
  async register(@Body(new ZodPipe(registerInput)) body: z.output<typeof registerInput>, @Res({ passthrough: true }) res: Response) {
    const passwordHash = await hash(body.password);
    try {
      // A new account owns a new workspace, identified by its own id (decision 0022).
      const user = await this.db.transaction(async (tx) => {
        const [u] = await tx.insert(users).values({ email: body.email, passwordHash, ...signupPlan() }).returning();
        await joinWorkspace(tx, u!.id, u!.id, "owner");
        return u!;
      });
      await this.startSession(user.id, res);
      return this.signedIn({ id: user.id, email: user.email, workspaceId: user.id, role: "owner", language: user.language });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("email already registered");
      throw err;
    }
  }

  @Post("login")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  async login(@Body(new ZodPipe(loginInput)) body: z.output<typeof loginInput>, @Res({ passthrough: true }) res: Response) {
    const [user] = await this.db.select().from(users).where(eq(users.email, body.email));
    dummyHash ??= hash("placeholder password");
    const ok = await verify(user?.passwordHash ?? (await dummyHash), body.password);
    if (!user || !ok) throw new UnauthorizedException("wrong email or password");
    const membership = await membershipOf(this.db, user.id);
    if (!membership) throw new ForbiddenException("this account is no longer a member of a workspace");
    await this.startSession(user.id, res);
    return this.signedIn({ id: user.id, email: user.email, ...membership, language: await workspaceLanguage(this.db, membership.workspaceId) });
  }

  /**
   * Accepts an invite link. A new email gets an account; an account that is in no workspace (a removed member) joins
   * with its own password; an account already in a workspace is refused. The invite, the account and the membership
   * are written in one transaction, so a refused or failed accept leaves the invite usable.
   */
  @Post("invites/:token/accept")
  @HttpCode(200)
  @UseGuards(RateLimit(ACCEPT_LIMIT))
  async acceptInvite(@Param("token", inviteToken) token: string, @Body(new ZodPipe(acceptInput)) body: z.output<typeof acceptInput>, @Res({ passthrough: true }) res: Response) {
    const newHash = await hash(body.password);
    const joined = await this.db.transaction(async (tx) => {
      const invite = await claimInvite(tx, token);
      if (!invite) throw new NotFoundException("this invite is not valid. It may have been used already or expired.");
      const [existing] = await tx.select().from(users).where(eq(users.email, invite.email));
      let userId = existing?.id;
      if (existing) {
        if (!(await verify(existing.passwordHash, body.password))) throw new UnauthorizedException("this email already has an account: enter its password");
        if (await membershipOf(tx, existing.id)) throw new ConflictException("this account already belongs to a workspace");
      } else {
        const [u] = await tx.insert(users).values({ email: invite.email, passwordHash: newHash }).returning();
        userId = u!.id;
      }
      await joinWorkspace(tx, userId!, invite.workspaceId, invite.role);
      return { id: userId!, email: invite.email, workspaceId: invite.workspaceId, role: invite.role };
    });
    await this.startSession(joined.id, res);
    return this.signedIn({ ...joined, language: await workspaceLanguage(this.db, joined.workspaceId) });
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token: unknown = req.cookies?.[COOKIE];
    if (typeof token === "string") await this.db.delete(sessions).where(eq(sessions.idHash, sha256(token)));
    res.clearCookie(COOKIE, { path: "/" });
  }

  /** Keeps this session and signs the account out everywhere else; a link asked for earlier stops working. */
  @Post("password")
  @HttpCode(204)
  @UseGuards(SessionGuard, RateLimit(10))
  async changePassword(@CurrentUser() user: SessionUser, @Req() req: Request, @Body(new ZodPipe(changePasswordInput)) body: z.output<typeof changePasswordInput>) {
    const [row] = await this.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    // A 400 and not a 401, so the console does not take it for a signed-out session.
    if (!row || !(await verify(row.passwordHash, body.currentPassword))) throw new BadRequestException("current password is wrong");
    const passwordHash = await hash(body.newPassword);
    const keep = sha256(String(req.cookies?.[COOKIE]));
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      await tx.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.idHash, keep)));
      await tx.update(passwordResets).set({ usedAt: sql`now()` }).where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));
    });
  }

  /**
   * Always 202 with the same body, whether or not the account exists. The lookup and the mail run after the response, so
   * the timing is the same too. The mail goes through the installation's server: it is a system message to the account's
   * own address, so an owner the operator has not approved for shared mail can still recover the account.
   */
  @Post("password-reset")
  @HttpCode(202)
  @UseGuards(RateLimit(5, 15 * 60_000))
  requestReset(@Body(new ZodPipe(resetRequestInput)) body: z.output<typeof resetRequestInput>) {
    void this.sendReset(body.email).catch((err: unknown) => console.error("password reset", err instanceof Error ? err.message : "failed"));
    return { ok: true };
  }

  /** One guarded UPDATE claims the link, so it works once; unknown, used and expired links get the same 400. */
  @Post("password-reset/:token")
  @HttpCode(204)
  @UseGuards(RateLimit(10))
  async useReset(@Param("token", inviteToken) token: string, @Body(new ZodPipe(acceptInput)) body: z.output<typeof acceptInput>) {
    const passwordHash = await hash(body.password);
    await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(passwordResets)
        .set({ usedAt: sql`now()` })
        .where(and(eq(passwordResets.tokenHash, sha256(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, sql`now()`)))
        .returning({ userId: passwordResets.userId });
      if (!claimed) throw new BadRequestException("this link is not valid. It may have been used already or expired.");
      await tx.update(users).set({ passwordHash }).where(eq(users.id, claimed.userId));
      await tx.delete(sessions).where(eq(sessions.userId, claimed.userId));
      await tx.update(passwordResets).set({ usedAt: sql`now()` }).where(and(eq(passwordResets.userId, claimed.userId), isNull(passwordResets.usedAt)));
    });
  }

  @Get("me")
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: SessionUser) {
    return this.signedIn(user);
  }

  private async sendReset(address: string) {
    const [user] = await this.db.select({ id: users.id, language: users.language }).from(users).where(eq(users.email, address));
    const mail = this.config.mail?.installation;
    if (!user || !mail) return;
    const token = randomBytes(32).toString("base64url");
    const stored = await this.db.transaction(async (tx) => {
      // The row lock makes the hourly cap hold when requests for one account arrive together.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("update");
      const [recent] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(passwordResets)
        .where(and(eq(passwordResets.userId, user.id), gt(passwordResets.createdAt, sql`now() - interval '1 hour'`)));
      if (recent!.n >= RESETS_PER_HOUR) return false;
      await tx.insert(passwordResets).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_MS) });
      return true;
    });
    if (!stored) return;
    const membership = await membershipOf(this.db, user.id);
    const copy = builtInEmailCopy(membership ? await workspaceLanguage(this.db, membership.workspaceId) : user.language);
    await mail.transport.sendMail({ from: mail.from, to: address, subject: copy.resetSubject, text: `${copy.resetBody}

${this.config.publicUrl}/#/reset-password/${token}` });
  }

  /** The user plus whether Ask about a request is on (AI_ASK, decision 0041), so the console knows without a reload. */
  private signedIn(user: SessionUser) {
    return { ...user, ask: this.config.ask === true };
  }

  /** The cookie holds 32 random bytes; the database holds only their SHA-256. */
  private async startSession(userId: string, res: Response) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_MS);
    await this.db.insert(sessions).values({ idHash: sha256(token), userId, expiresAt });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: this.config.secureCookies, path: "/", expires: expiresAt });
  }
}
