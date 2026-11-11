import { randomBytes } from "node:crypto";
import { sessions, users, type Db } from "@daloy/db";
import {
  Body,
  type CanActivate,
  ConflictException,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
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

const email = z.email().max(254).transform((s) => s.toLowerCase());
const registerInput = z.object({ email, password: z.string().min(12).max(200) });
const loginInput = z.object({ email, password: z.string().min(1).max(200) });

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const token: unknown = req.cookies?.[COOKIE];
    if (typeof token !== "string" || token.length > 100) throw new UnauthorizedException();
    const [user] = await this.db
      .select({ id: users.id, email: users.email })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.idHash, sha256(token)), gt(sessions.expiresAt, sql`now()`)));
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
  async register(@Body(new ZodPipe(registerInput)) body: z.output<typeof registerInput>, @Res({ passthrough: true }) res: Response) {
    try {
      const [user] = await this.db.insert(users).values({ email: body.email, passwordHash: await hash(body.password) }).returning();
      await this.startSession(user!.id, res);
      return { id: user!.id, email: user!.email };
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
    await this.startSession(user.id, res);
    return { id: user.id, email: user.email };
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
