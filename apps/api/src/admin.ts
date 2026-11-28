import { adminOverview, adminRuns, adminTotp, sessions, localConnection, PLANS, PRESET_IDS, PRESETS, readPlatformAi, savePlatformAi, setWorkspaceAiThinking, setWorkspacePlan, setWorkspaceSharedMail, sharedConnection, THINKING_LEVELS, type Db, type Plan } from "@daloy/db";
import { RUN_STATES, type RunState } from "@daloy/engine";
import { BadRequestException, Body, type CanActivate, Controller, type ExecutionContext, ForbiddenException, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import * as z from "zod";
import { fromOwnOrigin, sessionIdHash, sessionUser } from "./auth";
import { eq, sql } from "drizzle-orm";
import { CONFIG, CurrentUser, DB, onAdminHost, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";
import { sampleTest } from "./ai-sample";

/**
 * Whether this email is in PLATFORM_ADMINS, a comma-separated list matched trimmed and lowercased. An empty or unset
 * list turns the admin pages off (decision 0122).
 */
export function isPlatformAdmin(allowlist: string | undefined, email: string): boolean {
  const wanted = email.trim().toLowerCase();
  return wanted !== "" && (allowlist ?? "").split(",").some((e) => e.trim().toLowerCase() === wanted);
}

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/**
 * The platform admin behind this request, or a 404 for a missing or expired session and every account not in
 * PLATFORM_ADMINS, so to anyone else the routes do not exist. A workspace role never counts. With ADMIN_HOST set the
 * admin exists only on that host, and a change must come from https://<ADMIN_HOST> itself, with an Origin header
 * (decision 0157); without it, from this installation's own page as with SessionGuard.
 */
export async function platformAdmin(db: Db, config: ApiConfig, req: Request): Promise<SessionUser> {
  if (config.adminHost && !onAdminHost(req, config.adminHost)) throw new NotFoundException();
  const user = await sessionUser(db, req);
  if (!user || !isPlatformAdmin(config.platformAdmins, user.email)) throw new NotFoundException();
  const own = config.adminHost ? req.get("origin") === `https://${config.adminHost}` : fromOwnOrigin(req, config.publicUrl);
  if (!SAFE_METHODS.includes(req.method) && !own) throw new ForbiddenException("this change must be made from the kymavo admin page itself");
  return user;
}

export const TWO_FACTOR_HOURS = 12;

/**
 * Where this session stands with two-factor sign-in (decision 0158). verified needs a check on this session within
 * 12 hours and after the current enrollment was confirmed, so a reset and a new enrollment start over.
 */
export async function twoFactorState(db: Db, req: Request): Promise<{ enrolled: boolean; verified: boolean }> {
  const [row] = await db
    .select({
      enrolled: sql<boolean>`${adminTotp.confirmedAt} is not null`,
      verified: sql<boolean>`coalesce(${sessions.secondFactorAt} > now() - make_interval(hours => ${TWO_FACTOR_HOURS}) and ${sessions.secondFactorAt} >= ${adminTotp.confirmedAt}, false)`,
    })
    .from(sessions)
    .leftJoin(adminTotp, eq(adminTotp.userId, sessions.userId))
    .where(eq(sessions.idHash, sessionIdHash(req)));
  return { enrolled: row?.enrolled === true, verified: row?.verified === true };
}

/** An admin session that has not passed two-factor yet: only the admin page and the /admin/2fa routes use it. */
@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    req.user = await platformAdmin(this.db, this.config, req);
    return true;
  }
}

/**
 * The only way into the admin API: a platform admin (platformAdmin) whose session passed two-factor sign-in within
 * 12 hours. An admin not yet enrolled is told to set it up first (decision 0158).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = await platformAdmin(this.db, this.config, req);
    const state = await twoFactorState(this.db, req);
    if (!state.enrolled) throw new ForbiddenException({ statusCode: 403, message: "set up two-factor sign-in first", twoFactor: "setup" });
    if (!state.verified) throw new ForbiddenException({ statusCode: 403, message: "enter your two-factor code", twoFactor: "verify" });
    req.user = user;
    return true;
  }
}

const workspaceId = new ZodPipe(z.uuid());
const runsQuery = new ZodPipe(z.object({ state: z.enum(RUN_STATES).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }));
const planBody = new ZodPipe(z.object({ plan: z.enum(Object.keys(PLANS) as [Plan, ...Plan[]]).nullable(), startedOn: z.iso.date().optional() }));
// Like settingsInput in settings.ts: a key left out keeps the saved one, a thinking level left out keeps the saved level.
const platformAiBody = new ZodPipe(z.object({
  preset: z.enum(PRESET_IDS),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(500).optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
}));
const found = <T>(row: T | null) => {
  if (row === null) throw new NotFoundException("no workspace with this id");
  return row;
};

/** The Super-Admin page's API (A1). AdminGuard sits on the class, so no route here can skip it. */
@Controller("admin")
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  /** The shared model as the page shows it: the saved row or the env default. The key itself never leaves the database. */
  private async sharedAi() {
    const saved = await readPlatformAi(this.db);
    const local = localConnection();
    const current = saved ? { source: "platform" as const, ...saved } : { source: "env" as const, preset: "local", model: local.model, thinking: "off", hasKey: Boolean(process.env.LLM_API_KEY), keyLast4: null };
    const presets = Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, { label: p.label, defaultModel: id === "local" ? local.model : p.defaultModel, needsKey: p.needsKey, models: p.models }]));
    // Without SHARED_LLM_KEY=open the saved key is held back from every workspace (decision 0035), so the page can say so.
    return { current, presets, keyShared: process.env.SHARED_LLM_KEY === "open" };
  }

  @Get("ai")
  @UseGuards(RateLimit(30))
  getAi() {
    return this.sharedAi();
  }

  @Put("ai")
  @UseGuards(RateLimit(10))
  async putAi(@CurrentUser() admin: SessionUser, @Body(platformAiBody) body: { preset: (typeof PRESET_IDS)[number]; model: string; apiKey?: string; thinking?: (typeof THINKING_LEVELS)[number] }) {
    try {
      await savePlatformAi(this.db, this.config.secretsKey, admin.email, body);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return this.sharedAi();
  }

  /** One real model call on a sample inquiry, as a workspace on a plan would make it. Costs tokens, so it has its own limit. */
  @Post("ai/test")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  async testAi() {
    const { model, ...connection } = await sharedConnection(this.db, this.config.secretsKey, "pilot", null);
    return sampleTest(connection, model);
  }

  @Put("workspaces/:id/ai-thinking")
  @UseGuards(RateLimit(10))
  async aiThinking(@CurrentUser() admin: SessionUser, @Param("id", workspaceId) id: string, @Body(new ZodPipe(z.object({ level: z.enum(THINKING_LEVELS).nullable() }))) body: { level: (typeof THINKING_LEVELS)[number] | null }) {
    return found(await setWorkspaceAiThinking(this.db, admin.email, id, body.level));
  }

  @Get("overview")
  @UseGuards(RateLimit(30))
  overview() {
    return adminOverview(this.db);
  }

  @Get("runs")
  @UseGuards(RateLimit(30))
  runs(@Query(runsQuery) q: { state?: RunState; limit: number }) {
    return adminRuns(this.db, q);
  }

  @Put("workspaces/:id/plan")
  @UseGuards(RateLimit(10))
  async plan(@CurrentUser() admin: SessionUser, @Param("id", workspaceId) id: string, @Body(planBody) body: { plan: Plan | null; startedOn?: string }) {
    return found(await setWorkspacePlan(this.db, admin.email, id, body.plan, body.startedOn));
  }

  @Put("workspaces/:id/shared-mail")
  @UseGuards(RateLimit(10))
  async sharedMail(@CurrentUser() admin: SessionUser, @Param("id", workspaceId) id: string, @Body(new ZodPipe(z.object({ dailyLimit: z.number().int().min(1).max(10_000).nullable() }))) body: { dailyLimit: number | null }) {
    return found(await setWorkspaceSharedMail(this.db, admin.email, id, body.dailyLimit));
  }
}
