import { createHash } from "node:crypto";
import { RUN_QUEUE, type MailDeps, type ProviderUrls, type Role } from "@daloy/db";
import { parsePayload, resolveTemplate, type FormField, type Trigger } from "@daloy/engine";
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
/** mail and publicUrl are for the test email and its confirmation link; createApp fills them from the env vars when left out. */
export type ApiConfig = { secretsKey: Buffer; secureCookies: boolean; mail?: MailDeps; publicUrl?: string; providers?: ProviderUrls };

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
export type SessionUser = { id: string; email: string; workspaceId: string; role: Role };
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
export function validPayload(fields: FormField[] | undefined, data: unknown): Record<string, unknown> {
  const body = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  if (!fields) return body ?? {};
  const r = parsePayload(fields, data);
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

export async function enqueueRun(boss: PgBoss, runId: string) {
  await boss.send(RUN_QUEUE, { runId }, { singletonKey: runId });
}
