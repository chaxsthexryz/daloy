import { createHash } from "node:crypto";
import { RUN_QUEUE } from "@daloy/db";
import {
  BadRequestException,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
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
export type ApiConfig = { secretsKey: Buffer; secureCookies: boolean };

/** Validates a body, param or query value with zod at the route boundary. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new BadRequestException(result.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`));
    return result.data;
  }
}

export type SessionUser = { id: string; email: string };
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<{ user: SessionUser }>().user);

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Postgres unique violation, possibly wrapped by Drizzle. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) if ((e as { code?: string }).code === "23505") return true;
  return false;
}

/**
 * Fixed-window rate limit per client IP and route. A global one covers every route; stricter ones are added with @UseGuards.
 * shortcut: counters live in process memory, so each API instance limits on its own; move them to Postgres before running several instances.
 */
export function RateLimit(limit: number, windowMs = 60_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  @Injectable()
  class RateLimitGuard implements CanActivate {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest<{ ip?: string }>();
      const key = `${req.ip}:${ctx.getClass().name}.${ctx.getHandler().name}`;
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

export async function enqueueRun(boss: PgBoss, runId: string) {
  await boss.send(RUN_QUEUE, { runId }, { singletonKey: runId });
}
