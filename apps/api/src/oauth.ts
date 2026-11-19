import { consumeFlow, finishFlow, ProviderError, startFlow, type Db, type OAuthOutcome, type OAuthProvider } from "@daloy/db";
import { BadRequestException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import * as z from "zod";
import { SessionGuard, sessionUser } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, MANAGE, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";

const slugInput = new ZodPipe(z.string().regex(/^[a-z][a-z-]{1,29}$/));

/** Starts a consent flow for a provider on the shared OAuth core (decision 0058). Shared by the Outlook route that predates it. */
export async function startOAuth(db: Db, config: Required<ApiConfig>, def: OAuthProvider | undefined, user: SessionUser) {
  if (!def) throw new NotFoundException();
  if (!def.client(config.providers)) throw new BadRequestException(`${def.name} is not set up on this installation.`);
  return { url: await startFlow(db, config.secretsKey, config.providers, config.publicUrl, def, { workspaceId: user.workspaceId, memberId: user.id }) };
}

/** POST /settings/connections/:provider/oauth/start: the page opens the returned URL. Owners only, 10 a minute. */
@Controller("settings/connections")
@UseGuards(SessionGuard, Allow(MANAGE))
export class OAuthStartController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  @Post(":provider/oauth/start")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  start(@CurrentUser() user: SessionUser, @Param("provider", slugInput) slug: string) {
    return startOAuth(this.db, this.config, this.config.oauthProviders.find((d) => d.slug === slug), user);
  }
}

/**
 * Where providers send the browser back. Outside SessionGuard, because Microsoft's administrator consent comes back
 * without a Daloy session; that answer is the only one handled without a session, and it stores nothing. Every other
 * answer needs the signed-in member who started the flow, in the same workspace, still an owner. The browser is sent
 * to a fixed page with an outcome from a closed list; no parameter picks the target and provider text never reaches it.
 */
@Controller("settings/connections")
export class OAuthCallbackController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  @Get("oauth/callback")
  @UseGuards(RateLimit(60))
  callback(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, unknown>) {
    return this.handle(req, res, q, "oauth", (slug, outcome) => `/#/apps/${slug}-${outcome}`);
  }

  /** Outlook's redirect address from decision 0023, registered in existing Entra apps: the same handler and its old landing page. */
  @Get("outlook/callback")
  @UseGuards(RateLimit(60))
  outlookCallback(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, unknown>) {
    return this.handle(req, res, q, "outlook", (slug, outcome) => (slug === "outlook" ? `/#/settings/business/outlook-${outcome}` : `/#/apps/${slug}-${outcome}`));
  }

  private async handle(req: Request, res: Response, q: Record<string, unknown>, unknown: string, land: (slug: string, outcome: OAuthOutcome) => string) {
    // The address holds a single-use code: never cached, never sent on as a Referer.
    res.set({ "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
    const done = (slug: string, outcome: OAuthOutcome) => res.redirect(302, land(slug, outcome));
    const str = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
    if (str("admin_consent")) return done("outlook", str("admin_consent").toLowerCase() === "true" ? "admin_approved" : "admin_required");
    const user = await sessionUser(this.db, req);
    if (!user || !MANAGE.includes(user.role)) return done(unknown, "expired");
    const flow = await consumeFlow(this.db, this.config.secretsKey, str("state"), { workspaceId: user.workspaceId, memberId: user.id });
    const def = flow && this.config.oauthProviders.find((d) => d.provider === flow.provider);
    if (!flow || !def) return done(unknown, "expired");
    if (str("error")) return done(def.slug, def.outcome(str("error"), str("error_description")));
    try {
      return done(def.slug, await finishFlow(this.db, this.config.secretsKey, this.config.providers, this.config.publicUrl, def, user.workspaceId, str("code"), flow.verifier));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      return done(def.slug, "failed");
    }
  }
}
