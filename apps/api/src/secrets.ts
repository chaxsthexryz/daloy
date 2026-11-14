import { encryptSecret, retireSecret, secrets, type Db } from "@daloy/db";
import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Put, UseGuards } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, ZodPipe, type ApiConfig, type SessionUser, MANAGE } from "./http";

const secretName = new ZodPipe(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/, "use a-z, 0-9 and _"));
const secretInput = z.object({ value: z.string().min(1).max(10_000) });

/** Write-only: values go in, only names come back out. */
@Controller("secrets")
@UseGuards(SessionGuard, Allow(MANAGE))
export class SecretsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.db.select({ name: secrets.name, createdAt: secrets.createdAt }).from(secrets).where(eq(secrets.userId, user.workspaceId)).orderBy(asc(secrets.name));
  }

  @Put(":name")
  @HttpCode(204)
  async put(@CurrentUser() user: SessionUser, @Param("name", secretName) name: string, @Body(new ZodPipe(secretInput)) body: z.output<typeof secretInput>) {
    const encrypted = encryptSecret(this.config.secretsKey, user.workspaceId, name, body.value);
    // The old value stays known to run-history redaction after it is replaced (decision 0025).
    await this.db.transaction(async (tx) => {
      await retireSecret(tx, user.workspaceId, name);
      await tx
        .insert(secrets)
        .values({ userId: user.workspaceId, name, ...encrypted })
        .onConflictDoUpdate({ target: [secrets.userId, secrets.name], set: encrypted });
    });
  }

  @Delete(":name")
  @HttpCode(204)
  async remove(@CurrentUser() user: SessionUser, @Param("name", secretName) name: string) {
    const deleted = await this.db.transaction(async (tx) => {
      await retireSecret(tx, user.workspaceId, name);
      return tx.delete(secrets).where(and(eq(secrets.userId, user.workspaceId), eq(secrets.name, name))).returning({ id: secrets.id });
    });
    if (deleted.length === 0) throw new NotFoundException();
  }
}
