import { randomBytes } from "node:crypto";
import { apiTokens, type Db } from "@daloy/db";
import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { CurrentUser, DB, sha256, ZodPipe, type SessionUser } from "./http";

const tokenInput = z.object({ name: z.string().trim().min(1).max(100) });

/** Bearer tokens for MCP clients (phase 8). The token is shown once; only its SHA-256 is stored. */
@Controller("tokens")
@UseGuards(SessionGuard)
export class TokensController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post()
  async create(@CurrentUser() user: SessionUser, @Body(new ZodPipe(tokenInput)) body: z.output<typeof tokenInput>) {
    const token = `dly_${randomBytes(32).toString("base64url")}`;
    const [row] = await this.db.insert(apiTokens).values({ userId: user.id, name: body.name, tokenHash: sha256(token) }).returning({ id: apiTokens.id });
    return { id: row!.id, name: body.name, token };
  }

  @Get()
  list(@CurrentUser() user: SessionUser) {
    const { id, name, createdAt, lastUsedAt, revokedAt } = apiTokens;
    return this.db.select({ id, name, createdAt, lastUsedAt, revokedAt }).from(apiTokens).where(eq(apiTokens.userId, user.id)).orderBy(desc(createdAt));
  }

  @Delete(":id")
  @HttpCode(204)
  async revoke(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    const revoked = await this.db
      .update(apiTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, user.id), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    if (revoked.length === 0) throw new NotFoundException();
  }
}
