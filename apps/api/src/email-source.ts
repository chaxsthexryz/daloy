import {
  disconnectEmailSource,
  emailSourceInputSchema,
  readEmailSource,
  requestEmailSourceCheck,
  saveEmailSource,
  workflows,
  type Db,
} from "@daloy/db";
import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, UseGuards } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, MANAGE, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";

@Controller("workflows/:id/email-source")
@UseGuards(SessionGuard, Allow(MANAGE))
export class EmailSourceController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async read(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    await this.owned(user.workspaceId, id);
    return { source: await readEmailSource(this.db, id) };
  }

  @Put()
  @UseGuards(RateLimit(5))
  async connect(
    @CurrentUser() user: SessionUser,
    @Param("id", new ZodPipe(z.uuid())) id: string,
    @Body(new ZodPipe(emailSourceInputSchema)) body: z.output<typeof emailSourceInputSchema>,
  ) {
    await this.owned(user.workspaceId, id);
    return { source: await saveEmailSource(this.db, this.config.secretsKey, user.workspaceId, id, body) };
  }

  @Post("check")
  @UseGuards(RateLimit(5))
  @HttpCode(200)
  async check(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    await this.owned(user.workspaceId, id);
    const source = await requestEmailSourceCheck(this.db, id);
    if (!source) throw new NotFoundException("connect a mailbox first");
    return { source };
  }

  @Delete()
  @HttpCode(204)
  async disconnect(@CurrentUser() user: SessionUser, @Param("id", new ZodPipe(z.uuid())) id: string) {
    await this.owned(user.workspaceId, id);
    await disconnectEmailSource(this.db, id);
  }

  private async owned(workspaceId: string, id: string) {
    const [workflow] = await this.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.userId, workspaceId)));
    if (!workflow) throw new NotFoundException();
  }
}
