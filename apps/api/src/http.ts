import { createHash } from "node:crypto";
import { keyedRun, RUN_QUEUE, type Db, type MailDeps, type OAuthProvider, type ProviderUrls, type Role } from "@daloy/db";
import { parsePayload, resolveTemplate, type FormField, type Language, type Resource, type Trigger } from "@daloy/engine";
import {
  BadRequestException,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  type PipeTransform,
} from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import type * as z from "zod";

// DI tokens. vitest and tsx compile with esbuild, which emits no decorator metadata, so every injection names its token (decision 0005).
export const DB = Symbol("db");
export const BOSS = Symbol("boss");
export const CONFIG = Symbol("config");
/**
 * mail and publicUrl are for the test email and its confirmation link; createApp fills them from the env vars when left out.
 * oauthProviders defaults to OAUTH_PROVIDERS; tests add a definition for the fake OAuth app.
 * trustProxy is the number of proxies in front of the API (Express "trust proxy"), so req.ip is the real client.
 */
export type ApiConfig = { secretsKey: Buffer; secureCookies: boolean; trustProxy?: number; mail?: MailDeps; publicUrl?: string; providers?: ProviderUrls; ask?: boolean; oauthProviders?: readonly OAuthProvider[] };

/**
 * TRUST_PROXY and SECURE_COOKIES from the env (docs/deployment.md). A value that cannot be read stops the boot, so a
 * typo never leaves every client in one rate-limit bucket or the session cookie without Secure.
 */
export function deployEnv(env: Record<string, string | undefined>): { trustProxy: number; secureCookies: boolean } {
  const hops = env.TRUST_PROXY ?? "";
  if (!/^\d*$/.test(hops) || Number(hops) > 10) throw new Error(`TRUST_PROXY must be the number of proxies in front of the API (0 to 10), got "${hops}"`);
  const secure = env.SECURE_COOKIES ?? "";
  if (!["", "true", "false"].includes(secure)) throw new Error(`SECURE_COOKIES must be true or false, got "${secure}"`);
  return { trustProxy: Number(hops), secureCookies: secure === "true" || env.NODE_ENV === "production" };
}

/** Validates a body, param or query value with zod at the route boundary. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new BadRequestException(result.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`));
    return result.data;
  }
}

/**
 * The signed-in user and their place in a workspace (decision 0022). workspaceId is the owner's user id, which is what
 * every older `user_id` column holds, so owner-scoped queries filter on workspaceId.
 */
export type SessionUser = { id: string; email: string; workspaceId: string; role: Role; language: Language };
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<{ user: SessionUser }>().user);

/**
 * What each role may do. Routes name the rows they need with @UseGuards(Allow(...)) after SessionGuard. The approval
 * page checks its own rule, the named approver, in the database (decision 0022).
 */
export const MANAGE: Role[] = ["owner"];
export const OPERATE: Role[] = ["owner", "operator"];
export const ANY_MEMBER: Role[] = ["owner", "operator", "approver", "requester"];

export function Allow(roles: Role[]) {
  @Injectable()
  class RoleGuard implements CanActivate {
    canActivate(ctx: ExecutionContext) {
      const user = ctx.switchToHttp().getRequest<{ user?: SessionUser }>().user;
      if (!user || !roles.includes(user.role)) throw new ForbiddenException("your role in this workspace does not allow this");
      return true;
    }
  }
  return RoleGuard;
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Postgres unique violation, possibly wrapped by Drizzle. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) if ((e as { code?: string }).code === "23505") return true;
  return false;
}

/**
 * Fixed-window rate limit per route and per signed-in owner, or per client IP before sign-in. A global one covers every
 * route (it runs before sign-in is checked, so it is always per IP); stricter ones are added with @UseGuards.
 * shortcut: counters live in process memory, so each API instance limits on its own; move them to Postgres before running several instances.
 */
export function RateLimit(limit: number, windowMs = 60_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  @Injectable()
  class RateLimitGuard implements CanActivate {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest<{ ip?: string; user?: { id: string } }>();
      const key = `${req.user ? `user:${req.user.id}` : req.ip}:${ctx.getClass().name}.${ctx.getHandler().name}`;
      const now = Date.now();
      if (hits.size > 10_000) for (const [k, e] of hits) if (e.resetAt <= now) hits.delete(k);
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) hits.set(key, (entry = { count: 0, resetAt: now + windowMs }));
      if (++entry.count > limit) throw new HttpException("too many requests", HttpStatus.TOO_MANY_REQUESTS);
      return true;
    }
  }
  return RateLimitGuard;
}

/**
 * A run's trigger payload, checked against the trigger's fields when it has any (decision 0027). Declared fields come
 * back parsed (numbers as numbers, text trimmed); other keys pass through, since webhook events and test payloads
 * carry more than the fields name. A bad field is a 400 that names it.
 */
export function validPayload(fields: FormField[] | undefined, data: unknown, resources?: Resource[]): Record<string, unknown> {
  const body = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  if (!fields) return body ?? {};
  const r = parsePayload(fields, data, { resources });
  if (!r.ok) throw new BadRequestException(r.errors);
  const declared = new Set(fields.map((f) => f.name));
  return { ...Object.fromEntries(Object.entries(body ?? {}).filter(([k]) => !declared.has(k))), ...r.data };
}

/**
 * The business-event key of a run (decision 0029): the webhook trigger's eventKey resolved against the payload, else
 * the caller's own key (Idempotency-Key header, MCP idempotencyKey). undefined means every call is a new event.
 */
export function eventKey(trigger: Trigger, payload: Record<string, unknown>, callerKey?: string): string | undefined {
  const template = trigger.type === "webhook" ? trigger.config.eventKey : undefined;
  if (template === undefined) {
    if (callerKey !== undefined && (callerKey.length === 0 || callerKey.length > 200)) throw new BadRequestException(["Idempotency-Key: use 1 to 200 characters"]);
    return callerKey;
  }
  const v = resolveTemplate(template, { trigger: payload, steps: {} });
  const key = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (key.trim() === "") throw new BadRequestException([`eventKey: ${template} is empty for this event`]);
  if (key.length > 200) throw new BadRequestException([`eventKey: ${template} is longer than 200 characters for this event`]);
  return key;
}

/**
 * The first run of an event that was already accepted, looked up before the payload is checked again. A replay then
 * gets duplicate: true even when its payload would now be refused: a resource archived since, a time now past
 * (decision 0031). A key that cannot be read from the raw body leaves the normal checks to answer.
 * shortcut: the key is read from the raw body, so an eventKey template on a declared field whose stored form differs
 * (trimmed text, a datetime or resource) matches only after the checks; read the stored payload if such keys appear.
 */
export async function replayedRun(db: Db, workflowId: string, trigger: Trigger, body: unknown, callerKey?: string): Promise<string | undefined> {
  let key: string | undefined;
  try {
    key = eventKey(trigger, validPayload(undefined, body), callerKey);
  } catch {
    return undefined;
  }
  return key === undefined ? undefined : keyedRun(db, workflowId, key);
}

export async function enqueueRun(boss: PgBoss, runId: string) {
  await boss.send(RUN_QUEUE, { runId }, { singletonKey: runId });
}
