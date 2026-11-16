import { randomBytes } from "node:crypto";
import { claimInvite, joinWorkspace, membershipOf, sessions, users, workspaceMembers, type Db } from "@daloy/db";
import {
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
import { and, eq, gt, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import * as z from "zod";
import { CONFIG, CurrentUser, DB, isUniqueViolation, RateLimit, sha256, ZodPipe, type ApiConfig, type SessionUser } from "./http";

const COOKIE = "daloy_session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
// Sign-ups per client IP per hour. The test suites raise it, since every account there comes from 127.0.0.1.
const REGISTER_LIMIT = Number(process.env.REGISTER_LIMIT_PER_HOUR || 10);
if (!Number.isInteger(REGISTER_LIMIT) || REGISTER_LIMIT < 1) throw new Error("REGISTER_LIMIT_PER_HOUR must be a whole number above 0");

const email = z.email().max(254).transform((s) => s.toLowerCase());
const registerInput = z.object({ email, password: z.string().min(12).max(200) });
const loginInput = z.object({ email, password: z.string().min(1).max(200) });
// A new account needs the same 12 characters as register; an existing one checks its own password.
const acceptInput = z.object({ password: z.string().min(12).max(200) });
const inviteToken = new ZodPipe(z.string().regex(/^[A-Za-z0-9_-]{43}$/));

/**
 * The user behind the session cookie, with their workspace and role, or null. An account that is in no workspace
 * (a removed member) counts as signed out (decision 0022).
 */
export async function sessionUser(db: Db, req: Request): Promise<SessionUser | null> {
  const token: unknown = req.cookies?.[COOKIE];
  if (typeof token !== "string" || token.length > 100) return null;
  const [user] = await db
    .select({ id: users.id, email: users.email, workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .where(and(eq(sessions.idHash, sha256(token)), gt(sessions.expiresAt, sql`now()`)));
  return user ?? null;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = await sessionUser(this.db, req);
    if (!user) throw new UnauthorizedException();
    req.user = user;
    return true;
  }
}

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
        const [u] = await tx.insert(users).values({ email: body.email, passwordHash }).returning();
        await joinWorkspace(tx, u!.id, u!.id, "owner");
        return u!;
      });
      await this.startSession(user.id, res);
      return { id: user.id, email: user.email, workspaceId: user.id, role: "owner" };
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
    return { id: user.id, email: user.email, ...membership };
  }

  /**
   * Accepts an invite link. A new email gets an account; an account that is in no workspace (a removed member) joins
   * with its own password; an account already in a workspace is refused. The invite, the account and the membership
   * are written in one transaction, so a refused or failed accept leaves the invite usable.
   */
  @Post("invites/:token/accept")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
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
    return joined;
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token: unknown = req.cookies?.[COOKIE];
    if (typeof token === "string") await this.db.delete(sessions).where(eq(sessions.idHash, sha256(token)));
    res.clearCookie(COOKIE, { path: "/" });
  }

  @Get("me")
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: SessionUser) {
    return user;
  }

  /** The cookie holds 32 random bytes; the database holds only their SHA-256. */
  private async startSession(userId: string, res: Response) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_MS);
    await this.db.insert(sessions).values({ idHash: sha256(token), userId, expiresAt });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: this.config.secureCookies, path: "/", expires: expiresAt });
  }
}
