import { notionDatabase, notionDatabases, notionId, type Db } from "@daloy/db";
import { Body, Controller, Get, HttpCode, Inject, Put, UseGuards } from "@nestjs/common";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, MANAGE, RateLimit, ZodPipe, type SessionUser } from "./http";
import { notInList, oauthConnection, pickerCall, saveRecordTarget, type Config } from "./oauth-records";

const targetInput = z.strictObject({ databaseId: z.string().regex(/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i).transform(notionId) });

/** The database picker: databases the owner shared with Daloy on Notion's consent screen. Owners only. */
@Controller("settings/connections/notion")
@UseGuards(SessionGuard, Allow(MANAGE))
export class NotionOAuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get("databases")
  @UseGuards(RateLimit(20))
  async databases(@CurrentUser() user: SessionUser) {
    const conn = await oauthConnection(this.db, this.config, user, "notion");
    return pickerCall(this.db, this.config, user, "notion", conn, (t) => notionDatabases(this.config.providers, t));
  }

  /** Saves the database (it must be in the list read now), with the name of its title property, which every page needs. */
  @Put("target")
  @HttpCode(204)
  @UseGuards(RateLimit(20))
  async target(@CurrentUser() user: SessionUser, @Body(new ZodPipe(targetInput)) body: z.output<typeof targetInput>) {
    const conn = await oauthConnection(this.db, this.config, user, "notion");
    const found = await pickerCall(this.db, this.config, user, "notion", conn, async (t) =>
      (await notionDatabases(this.config.providers, t)).some((d) => d.id === body.databaseId) ? notionDatabase(this.config.providers, t, body.databaseId) : undefined,
    );
    if (!found) throw notInList("database");
    await saveRecordTarget(this.db, user, "notion", conn, { databaseId: found.databaseId, databaseTitle: found.databaseTitle, titleProperty: found.titleProperty });
  }
}
