import { BadRequestException, ConflictException, Controller, Get, Header, Inject, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import { connectionCredential, markConnectionFailed, PROVIDER_NAMES, ProviderError, recordTriggerStatus, setDestination, withRecordAuth, type Db, type Provider, type RecordTriggerType } from "@daloy/db";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CurrentUser, DB, OPERATE, RateLimit, ZodPipe, type ApiConfig, type SessionUser } from "./http";
import { historyHider } from "./mask";

/**
 * What the Airtable, Notion and Trello pickers share (decision 0062). A picker needs the OAuth sign-in: a pasted
 * token has its own form. Every list is read with the connection's own token, and the saved target must be in the
 * lists read again at save time, so a forged id gains nothing.
 */
export type Config = Required<ApiConfig>;

/** The workspace's connection, which must be an OAuth grant. */
export async function oauthConnection(db: Db, config: Config, user: SessionUser, provider: Provider) {
  const conn = await connectionCredential(db, config.secretsKey, user.workspaceId, provider);
  if (!conn) throw new NotFoundException(`${PROVIDER_NAMES[provider]} is not connected.`);
  if (conn.authMethod !== "oauth") throw new BadRequestException(`Use Connect ${PROVIDER_NAMES[provider]} to pick from a list. A pasted token has no lists.`);
  return conn;
}

/** Runs fn with the connection's access token. A provider's answer becomes a 400 the page can show; a rejected grant also marks the connection failed. */
export async function pickerCall<T>(db: Db, config: Config, user: SessionUser, provider: Provider, conn: Awaited<ReturnType<typeof oauthConnection>>, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await withRecordAuth(db, config.secretsKey, config.providers, user.workspaceId, config.oauthProviders.find((d) => d.provider === provider), conn, fn);
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.kind === "auth") await markConnectionFailed(db, user.workspaceId, provider, err.message, conn.revision);
    const hide = await historyHider(db, config.secretsKey, user.workspaceId);
    throw new BadRequestException(hide(err.message) as string);
  }
}

export const notInList = (what: string) => new BadRequestException(`That ${what} is not in the list. Refresh the list and pick again.`);


/** Save only against the credential that verified the list. Reconnecting during a picker read requires another pick. */
export async function saveRecordTarget(db: Db, user: SessionUser, provider: Provider, conn: Awaited<ReturnType<typeof oauthConnection>>, destination: Record<string, string>) {
  if (!(await setDestination(db, user.workspaceId, provider, destination, conn.revision))) throw new ConflictException("The connection changed while the list was loading. Refresh the list and pick again.");
}

const statusSchema = z.strictObject({ workflowId: z.uuid().optional() });

/**
 * G5 (decision 0134): what the editor shows under an Airtable, Notion or Trello trigger. Whether the app is connected
 * with read access and a destination (no network), and the watcher's last check for a saved automation.
 */
@Controller("triggers/records")
@UseGuards(SessionGuard, Allow(OPERATE))
export class RecordTriggersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get(":type")
  @Header("Cache-Control", "no-store")
  @UseGuards(RateLimit(30))
  async status(
    @CurrentUser() user: SessionUser,
    @Param("type", new ZodPipe(z.enum(["airtable_record", "notion_page", "trello_card"]))) type: RecordTriggerType,
    @Query(new ZodPipe(statusSchema)) q: z.output<typeof statusSchema>,
  ) {
    return recordTriggerStatus(this.db, user.workspaceId, type, q.workflowId);
  }
}
