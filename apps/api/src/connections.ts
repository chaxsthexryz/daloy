import {
  appendRow,
  confirmDelivery,
  connectionCredential,
  deliveries,
  listDeliveries,
  markConnectionFailed,
  markConnectionWorking,
  ProviderError,
  readConnections,
  removeConnection,
  retryDelivery,
  saveConnection,
  serviceAccountSchema,
  setDestination,
  sheetInfo,
  slackChannels,
  slackIdentity,
  slackPost,
  spreadsheetIdFrom,
  type Db,
  type Provider,
  type ProviderUrls,
  type ServiceAccount,
  type SheetDestination,
} from "@daloy/db";
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, RateLimit, ZodPipe, type ApiConfig, type SessionUser, MANAGE, OPERATE } from "./http";

const sheetsInput = z.strictObject({ serviceAccount: z.string().min(2).max(10_000), sheet: z.string().trim().min(1).max(500), tab: z.string().trim().min(1).max(100) });
const destinationInput = sheetsInput.omit({ serviceAccount: true });
// Bot tokens only (xoxb-): a user token (xoxp-) would post as a person.
const slackInput = z.strictObject({ token: z.string().trim().regex(/^xoxb-[A-Za-z0-9-]{10,200}$/, "Paste the Bot User OAuth Token, which starts with xoxb-") });
const channelInput = z.strictObject({ channelId: z.string().regex(/^[CG][A-Z0-9]{2,20}$/) });
const retryInput = z.strictObject({ postAgain: z.boolean().default(false) });
const uuid = new ZodPipe(z.uuid());

/** A provider's answer as a 400 the console can show. Anything else is a real error. */
function asBadRequest(err: unknown): never {
  if (err instanceof ProviderError) throw new BadRequestException(err.message);
  throw err;
}

/**
 * Business and email, Connections (roadmap phase 3, decision 0021). One Google Sheets and one Slack connection per owner,
 * each with its destination. Credentials are write-only: no response ever includes one.
 */
@Controller("settings/connections")
@UseGuards(SessionGuard, Allow(MANAGE))
export class ConnectionsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  private get urls(): ProviderUrls {
    return this.config.providers;
  }

  @Get()
  async get(@CurrentUser() user: SessionUser) {
    return { connections: await readConnections(this.db, user.workspaceId) };
  }

  /** The sheet and tab, checked with a read before saving. Shared by connect and "change sheet". */
  private async destination(sa: ServiceAccount, input: z.output<typeof destinationInput>) {
    const spreadsheetId = spreadsheetIdFrom(input.sheet);
    if (!spreadsheetId) throw new BadRequestException("Paste the sheet's link from the browser address bar.");
    const info = await sheetInfo(this.urls, sa, spreadsheetId).catch(asBadRequest);
    if (!info.tabs.includes(input.tab)) throw new BadRequestException(`The sheet has no tab called "${input.tab}". Its tabs are: ${info.tabs.join(", ")}.`);
    return { spreadsheetId, tab: input.tab, title: info.title };
  }

  /** Connect or Reconnect Google Sheets: a service account key file, and a sheet shared with that account. Only the email and key are kept. */
  @Put("google-sheets")
  @UseGuards(RateLimit(10))
  async putSheets(@CurrentUser() user: SessionUser, @Body(new ZodPipe(sheetsInput)) body: z.output<typeof sheetsInput>) {
    let sa: ServiceAccount;
    try {
      sa = serviceAccountSchema.parse(JSON.parse(body.serviceAccount));
    } catch {
      throw new BadRequestException("That is not a service account key file. In Google Cloud, create a key for the service account as JSON and paste the whole file.");
    }
    const destination = await this.destination(sa, body);
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "google_sheets", { account: sa.client_email, credential: JSON.stringify({ client_email: sa.client_email, private_key: sa.private_key }), destination });
    return this.get(user);
  }

  /** Change sheet: another sheet or tab with the stored key. */
  @Put("google-sheets/destination")
  @HttpCode(204)
  @UseGuards(RateLimit(10))
  async putSheetDestination(@CurrentUser() user: SessionUser, @Body(new ZodPipe(destinationInput)) body: z.output<typeof destinationInput>) {
    const conn = await this.connection(user.workspaceId, "google_sheets");
    await setDestination(this.db, user.workspaceId, "google_sheets", await this.destination(JSON.parse(conn.credential) as ServiceAccount, body));
  }

  /** Adds a visible test row, which proves Daloy can write (a shared-as-viewer sheet passes the read check but fails here). */
  @Post("google-sheets/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testSheets(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "google_sheets");
    const stamp = new Date().toISOString();
    return this.test(user.workspaceId, "google_sheets", () =>
      appendRow(this.urls, JSON.parse(conn.credential) as ServiceAccount, conn.destination as SheetDestination, [`TEST-${stamp}`, stamp, "Test row from Daloy. You can delete this row."]),
    );
  }

  /** Connect or Reconnect Slack with the app's bot token. A reconnect keeps the chosen channel. */
  @Put("slack")
  @UseGuards(RateLimit(10))
  async putSlack(@CurrentUser() user: SessionUser, @Body(new ZodPipe(slackInput)) body: z.output<typeof slackInput>) {
    const { team } = await slackIdentity(this.urls, body.token).catch(asBadRequest);
    const old = await connectionCredential(this.db, this.config.secretsKey, user.workspaceId, "slack");
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "slack", { account: team, credential: body.token, destination: old?.destination ?? null });
    return this.get(user);
  }

  @Get("slack/channels")
  @UseGuards(RateLimit(20))
  async channels(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "slack");
    return slackChannels(this.urls, conn.credential).catch(asBadRequest);
  }

  @Put("slack/channel")
  @HttpCode(204)
  async putChannel(@CurrentUser() user: SessionUser, @Body(new ZodPipe(channelInput)) body: z.output<typeof channelInput>) {
    const conn = await this.connection(user.workspaceId, "slack");
    const channel = (await slackChannels(this.urls, conn.credential).catch(asBadRequest)).find((c) => c.id === body.channelId);
    if (!channel) throw new BadRequestException("That channel is not in the list. Refresh the channel list and pick again.");
    await setDestination(this.db, user.workspaceId, "slack", { channelId: channel.id, channelName: channel.name });
  }

  @Post("slack/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testSlack(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "slack");
    return this.test(user.workspaceId, "slack", () => slackPost(this.urls, conn.credential, conn.destination!.channelId!, "Test message from Daloy. Office requests will be posted here."));
  }

  @Delete("google-sheets")
  @HttpCode(204)
  async removeSheets(@CurrentUser() user: SessionUser) {
    if (!(await removeConnection(this.db, user.workspaceId, "google_sheets"))) throw new NotFoundException();
  }

  @Delete("slack")
  @HttpCode(204)
  async removeSlack(@CurrentUser() user: SessionUser) {
    if (!(await removeConnection(this.db, user.workspaceId, "slack"))) throw new NotFoundException();
  }

  private async connection(userId: string, provider: Provider) {
    const conn = await connectionCredential(this.db, this.config.secretsKey, userId, provider);
    if (!conn) throw new NotFoundException(`${provider === "slack" ? "Slack" : "Google Sheets"} is not connected.`);
    return conn;
  }

  /** ok: true means the provider accepted the write. A rejected credential marks the connection failed, as a delivery would. */
  private async test(userId: string, provider: Provider, send: () => Promise<Record<string, string>>) {
    const conn = await this.connection(userId, provider);
    if (!conn.destination) return { ok: false, error: provider === "slack" ? "Pick a channel first." : "Pick a sheet first." };
    try {
      const result = await send();
      await markConnectionWorking(this.db, userId, provider);
      return { ok: true, ...result };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === "auth") await markConnectionFailed(this.db, userId, provider, err.message);
      return { ok: false, error: err.message };
    }
  }
}

/** Activity for one run, and the operator's Retry, Post again and Mark as posted. */
@Controller("deliveries")
@UseGuards(SessionGuard, Allow(OPERATE))
export class DeliveriesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@CurrentUser() user: SessionUser, @Query("runId", uuid) runId: string) {
    return listDeliveries(this.db, user.workspaceId, [runId]);
  }

  /** Queues a failed delivery again (the worker sends it within seconds). postAgain repeats a Slack post that may be in the channel already. */
  @Post(":id/retry")
  @HttpCode(204)
  @UseGuards(RateLimit(30))
  async retry(@CurrentUser() user: SessionUser, @Param("id", uuid) id: string, @Body(new ZodPipe(retryInput)) body: z.output<typeof retryInput>) {
    if (!(await retryDelivery(this.db, user.workspaceId, id, body))) await this.conflict(user.workspaceId, id);
  }

  @Post(":id/confirm")
  @HttpCode(204)
  async confirm(@CurrentUser() user: SessionUser, @Param("id", uuid) id: string) {
    if (!(await confirmDelivery(this.db, user.workspaceId, id))) await this.conflict(user.workspaceId, id);
  }

  /** Someone else's delivery and an unknown id look the same. Your own one in another state is a 409 that names the state. */
  private async conflict(userId: string, id: string): Promise<never> {
    const [row] = await this.db.select({ state: deliveries.state }).from(deliveries).where(and(eq(deliveries.id, id), eq(deliveries.userId, userId)));
    if (!row) throw new NotFoundException();
    throw new ConflictException(`This delivery is ${row.state.replace("_", " ")}, so there is nothing to do.`);
  }
}
