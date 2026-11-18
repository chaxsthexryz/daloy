import { randomBytes } from "node:crypto";
import { apiTokens, TOKEN_SCOPES, type Db } from "@daloy/db";
import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CurrentUser, DB, sha256, ZodPipe, type SessionUser, MANAGE } from "./http";

const tokenInput = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).refine((s) => new Set(s).size === s.length, "each scope once"),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

/** Bearer tokens for MCP clients (phase 8). The token is shown once; only its SHA-256 is stored. */
@Controller("tokens")
@UseGuards(SessionGuard, Allow(MANAGE))
export class TokensController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post()
  async create(@CurrentUser() user: SessionUser, @Body(new ZodPipe(tokenInput)) body: z.output<typeof tokenInput>) {
    const token = `dly_${randomBytes(32).toString("base64url")}`;
    const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null;
    const [row] = await this.db
      .insert(apiTokens)
      .values({ userId: user.workspaceId, name: body.name, tokenHash: sha256(token), scopes: body.scopes, expiresAt })
      .returning({ id: apiTokens.id });
    return { id: row!.id, name: body.name, token, scopes: body.scopes, expiresAt };
  }

  @Get()
  list(@CurrentUser() user: SessionUser) {
    const { id, name, scopes, expiresAt, createdAt, lastUsedAt, revokedAt } = apiTokens;
    return this.db.select({ id, name, scopes, expiresAt, createdAt, lastUsedAt, revokedAt }).from(apiTokens).where(eq(apiTokens.userId, user.workspaceId)).orderBy(desc(createdAt));
  }

  @Delete(":id")
  @HttpCode(204)
  async revoke(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    const revoked = await this.db
      .update(apiTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, user.workspaceId), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    if (revoked.length === 0) throw new NotFoundException();
  }
}
