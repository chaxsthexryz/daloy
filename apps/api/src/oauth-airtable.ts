import { airtableBases, airtableTables, setDestination, type Db } from "@daloy/db";
import { Body, Controller, Get, HttpCode, Inject, Param, Put, UseGuards } from "@nestjs/common";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, MANAGE, RateLimit, ZodPipe, type SessionUser } from "./http";
import { notInList, oauthConnection, pickerCall, type Config } from "./oauth-records";

// Airtable ids: a base is app..., a table is tbl... (a name is never accepted, security review M16).
const baseParam = new ZodPipe(z.string().regex(/^app[A-Za-z0-9]{10,30}$/));
const targetInput = z.strictObject({ baseId: z.string().regex(/^app[A-Za-z0-9]{10,30}$/), tableId: z.string().regex(/^tbl[A-Za-z0-9]{14}$/) });

/** The base and table pickers, read through schema.bases:read. Owners only. */
@Controller("settings/connections/airtable")
@UseGuards(SessionGuard, Allow(MANAGE))
export class AirtableOAuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get("bases")
  @UseGuards(RateLimit(20))
  async bases(@CurrentUser() user: SessionUser) {
    const conn = await oauthConnection(this.db, this.config, user, "airtable");
    return pickerCall(this.db, this.config, user, "airtable", conn, (t) => airtableBases(this.config.providers, t));
  }

  @Get("bases/:baseId/tables")
  @UseGuards(RateLimit(20))
  async tables(@CurrentUser() user: SessionUser, @Param("baseId", baseParam) baseId: string) {
    const conn = await oauthConnection(this.db, this.config, user, "airtable");
    return pickerCall(this.db, this.config, user, "airtable", conn, (t) => airtableTables(this.config.providers, t, baseId));
  }

  /** Saves the target. The base and table must be in the lists read now with the connection's own token. */
  @Put("target")
  @HttpCode(204)
  @UseGuards(RateLimit(20))
  async target(@CurrentUser() user: SessionUser, @Body(new ZodPipe(targetInput)) body: z.output<typeof targetInput>) {
    const conn = await oauthConnection(this.db, this.config, user, "airtable");
    const { base, table } = await pickerCall(this.db, this.config, user, "airtable", conn, async (t) => {
      const base = (await airtableBases(this.config.providers, t)).find((b) => b.id === body.baseId);
      return { base, table: base && (await airtableTables(this.config.providers, t, base.id)).find((x) => x.id === body.tableId) };
    });
    if (!base) throw notInList("base");
    if (!table) throw notInList("table");
    await setDestination(this.db, user.workspaceId, "airtable", { baseId: base.id, tableId: table.id, baseName: base.name, tableName: table.name });
  }
}
