import { builtInEmailCopy } from "@daloy/engine";
import { randomBytes } from "node:crypto";
import {
  appendRow,
  calendarIdFrom,
  calendarInfo,
  calendarWriteTest,
  driveFolderIdFrom,
  driveFolderInfo,
  confirmDelivery,
  connectionCredential,
  deliveries,
  listDeliveries,
  markConnectionFailed,
  markConnectionWorking,
  outlookAdminConsentUrl,
  outlook,
  redirectUri,
  disconnectOAuth,
  removeConnection,
  withFreshToken,
  withGoogle,
  outlookSend,
  checkPaymongoKey,
  paymongoMode,
  PROVIDER_NAMES,
  ProviderError,
  readConnections,
  retryDelivery,
  BOOKING_CHANGED,
  deliveryBookingMoved,
  saveConnection,
  serviceAccountSchema,
  setDestination,
  sheetInfo,
  slackChannels,
  slackToken,
  slackIdentity,
  slackPost,
  airtableCheck,
  notionAddPage,
  notionDatabase,
  trelloAddCard,
  trelloIdentity,
  trelloList,
  telegramChat,
  telegramIdentity,
  telegramSend,
  spreadsheetIdFrom,
  teamsPost,
  teamsWebhookUrl,
  type Db,
  type Provider,
  type ProviderUrls,
  type ServiceAccount,
  type SheetDestination,
} from "@daloy/db";
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, Res, UseGuards } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import type { Response } from "express";
import { SessionGuard } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, RateLimit, ZodPipe, type ApiConfig, type SessionUser, MANAGE, OPERATE } from "./http";
import { historyHider } from "./mask";
import { startOAuth } from "./oauth";

const sheetsInput = z.strictObject({ serviceAccount: z.string().min(2).max(10_000), sheet: z.string().trim().min(1).max(500), tab: z.string().trim().min(1).max(100) });
const destinationInput = sheetsInput.omit({ serviceAccount: true });
// Bot tokens only (xoxb-): a user token (xoxp-) would post as a person.
const slackInput = z.strictObject({ token: z.string().trim().regex(/^xoxb-[A-Za-z0-9-]{10,200}$/, "Paste the Bot User OAuth Token, which starts with xoxb-") });
const channelInput = z.strictObject({ channelId: z.string().regex(/^[CG][A-Z0-9]{2,20}$/) });
// A bot token is <bot id>:<secret>; a chat is a numeric id (negative for groups) or a public @name.
const telegramInput = z.strictObject({
  token: z.string().trim().regex(/^\d{6,12}:[A-Za-z0-9_-]{30,50}$/, "Paste the bot token from BotFather, like 123456789:AA..."),
  chatId: z.string().trim().regex(/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/, "Enter the chat id (a number) or the public @name"),
});
// PayMongo's secret key and the signing secret of the webhook the owner made in PayMongo. Both are kept encrypted and never returned.
const paymongoInput = z.strictObject({
  secretKey: z.string().trim().regex(/^sk_(test|live)_\S+$/, "Paste the secret key from PayMongo, which starts with sk_test_ or sk_live_"),
  webhookSecret: z.string().trim().regex(/^whsk_\S+$/, "Paste the webhook secret from PayMongo, which starts with whsk_"),
});
// Airtable: a personal access token (pat...), a base id (app...) and a table id (tbl...) or name. Notion: an internal
// integration token and a database id (or the link to it). Trello: the API key, a token, and a list id (decision 0046).
const airtableInput = z.strictObject({
  token: z.string().trim().regex(/^pat[A-Za-z0-9]+\.[A-Za-z0-9]{20,100}$/, "Paste the personal access token, which starts with pat"),
  baseId: z.string().trim().regex(/^app[A-Za-z0-9]{10,30}$/, "The base id starts with app"),
  tableId: z.string().trim().regex(/^tbl[A-Za-z0-9]{14}$/, "Enter the table id, which starts with tbl (it is in the table's link)"),
});
const notionInput = z.strictObject({
  token: z.string().trim().regex(/^(secret_|ntn_)[A-Za-z0-9]{20,100}$/, "Paste the internal integration secret, which starts with ntn_ or secret_"),
  database: z.string().trim().max(500).transform((s, ctx) => {
    const id = /[0-9a-f]{32}/i.exec(s.replace(/-/g, ""))?.[0]?.toLowerCase();
    if (!id) ctx.addIssue({ code: "custom", message: "Paste the database link or its 32-character id" });
    return id ?? "";
  }),
});
const trelloInput = z.strictObject({
  key: z.string().trim().regex(/^[a-f0-9]{32}$/i, "The API key is 32 letters and digits"),
  token: z.string().trim().regex(/^[A-Za-z0-9_-]{32,200}$/, "Paste the token you got after allowing access"),
  listId: z.string().trim().regex(/^[a-f0-9]{24}$/i, "The list id is 24 letters and digits"),
});
const calendarInput = z.strictObject({ serviceAccount: z.string().min(2).max(10_000), calendar: z.string().trim().min(3).max(300) });
const driveInput = z.strictObject({ serviceAccount: z.string().min(2).max(10_000), folder: z.string().trim().min(3).max(500) });
const retryInput = z.strictObject({ postAgain: z.boolean().default(false) });
const teamsInput = z.strictObject({ url: z.string().trim().min(10).max(2000), channelName: z.string().trim().min(1).max(100) });
const SLUGS: Record<string, Provider> = { "google-sheets": "google_sheets", slack: "slack", outlook: "outlook", teams: "teams", telegram: "telegram", "google-calendar": "google_calendar", "google-drive": "google_drive", paymongo: "paymongo", airtable: "airtable", notion: "notion", trello: "trello" };
const providerSlug = new ZodPipe(z.enum(Object.keys(SLUGS) as [string, ...string[]]).transform((s) => SLUGS[s]!));
const uuid = new ZodPipe(z.uuid());

/** A provider's answer as a 400 the console can show. Anything else is a real error. */
function asBadRequest(err: unknown): never {
  if (err instanceof ProviderError) throw new BadRequestException(err.message);
  throw err;
}

/**
 * Apps (was Business and email), connections (roadmap phase 3, decision 0021). One Google Sheets and one Slack connection per owner,
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
    const ms = this.urls.microsoft ? { configured: true, adminConsentUrl: outlookAdminConsentUrl(this.urls, redirectUri(this.config.publicUrl, outlook)) } : { configured: false };
    // The providers with a Connect button: their client is configured on this installation (decision 0058).
    const oauth = this.config.oauthProviders.filter((d) => d.client(this.urls)).map((d) => d.slug);
    return { connections: await readConnections(this.db, user.workspaceId), outlook: ms, oauth, paymongoWebhookBase: `${this.config.publicUrl}/hooks/paymongo` };
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
    if (conn.authMethod === "oauth") throw new BadRequestException("This connection uses a Google sign-in. Pick or create the sheet instead.");
    await setDestination(this.db, user.workspaceId, "google_sheets", await this.destination(JSON.parse(conn.credential) as ServiceAccount, body));
  }

  /** Adds a visible test row, which proves Daloy can write (a shared-as-viewer sheet passes the read check but fails here). */
  @Post("google-sheets/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testSheets(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "google_sheets");
    const stamp = new Date().toISOString();
    // force: with a Google sign-in, a test proves the grant itself still works (decision 0058).
    return this.test(user.workspaceId, "google_sheets", conn, () =>
      withGoogle(this.db, this.config.secretsKey, this.urls, user.workspaceId, "google_sheets", conn, (auth) => appendRow(this.urls, auth, conn.destination as SheetDestination, [`TEST-${stamp}`, stamp, "Test row from Daloy. You can delete this row."]), { force: true }),
    );
  }

  /** Connect or Reconnect Google Calendar: the same kind of service account key as Sheets, and a calendar shared with that account. Only the email and key are kept. */
  @Put("google-calendar")
  @UseGuards(RateLimit(10))
  async putCalendar(@CurrentUser() user: SessionUser, @Body(new ZodPipe(calendarInput)) body: z.output<typeof calendarInput>) {
    let sa: ServiceAccount;
    try {
      sa = serviceAccountSchema.parse(JSON.parse(body.serviceAccount));
    } catch {
      throw new BadRequestException("That is not a service account key file. In Google Cloud, create a key for the service account as JSON and paste the whole file.");
    }
    const calendarId = calendarIdFrom(body.calendar);
    if (!calendarId) throw new BadRequestException("Paste the calendar's id from its settings (Integrate calendar), like abc123@group.calendar.google.com.");
    const { title } = await calendarInfo(this.urls, sa, calendarId).catch(asBadRequest);
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "google_calendar", { account: sa.client_email, credential: JSON.stringify({ client_email: sa.client_email, private_key: sa.private_key }), destination: { calendarId, title } });
    return this.get(user);
  }

  /** Makes and removes a test event, which proves Daloy can write. */
  @Post("google-calendar/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testCalendar(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "google_calendar");
    // force: with a Google sign-in, a test proves the grant itself still works (decision 0058).
    return this.test(user.workspaceId, "google_calendar", conn, () =>
      withGoogle(this.db, this.config.secretsKey, this.urls, user.workspaceId, "google_calendar", conn, (auth) => calendarWriteTest(this.urls, auth, conn.destination!.calendarId!), { force: true }),
    );
  }

  /** Connect or Reconnect Google Drive: a service account key, and a folder inside a shared drive that the account can add files to. Only the email and key are kept. */
  @Put("google-drive")
  @UseGuards(RateLimit(10))
  async putDrive(@CurrentUser() user: SessionUser, @Body(new ZodPipe(driveInput)) body: z.output<typeof driveInput>) {
    let sa: ServiceAccount;
    try {
      sa = serviceAccountSchema.parse(JSON.parse(body.serviceAccount));
    } catch {
      throw new BadRequestException("That is not a service account key file. In Google Cloud, create a key for the service account as JSON and paste the whole file.");
    }
    const folderId = driveFolderIdFrom(body.folder);
    if (!folderId) throw new BadRequestException("Paste the folder's link from the browser address bar, like https://drive.google.com/drive/folders/...");
    const { title } = await driveFolderInfo(this.urls, sa, folderId).catch(asBadRequest);
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "google_drive", { account: sa.client_email, credential: JSON.stringify({ client_email: sa.client_email, private_key: sa.private_key }), destination: { folderId, title } });
    return this.get(user);
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

  /** Connect or Reconnect Telegram: the bot must work and see the chat, and both are saved together. The token is never returned. */
  @Put("telegram")
  @UseGuards(RateLimit(10))
  async putTelegram(@CurrentUser() user: SessionUser, @Body(new ZodPipe(telegramInput)) body: z.output<typeof telegramInput>) {
    const { bot } = await telegramIdentity(this.urls, body.token).catch(asBadRequest);
    const chat = await telegramChat(this.urls, body.token, body.chatId).catch(asBadRequest);
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "telegram", { account: bot, credential: body.token, destination: chat });
    return this.get(user);
  }

  @Post("telegram/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testTelegram(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "telegram");
    return this.test(user.workspaceId, "telegram", conn, () => telegramSend(this.urls, conn.credential, conn.destination!.chatId!, "Test message from Daloy."));
  }

  /** Connect or Reconnect PayMongo. The webhook path is made once and kept, so the URL given to PayMongo keeps working. */
  @Put("paymongo")
  @UseGuards(RateLimit(10))
  async putPaymongo(@CurrentUser() user: SessionUser, @Body(new ZodPipe(paymongoInput)) body: z.output<typeof paymongoInput>) {
    const mode = paymongoMode(body.secretKey);
    if (mode === "live" && process.env.PAYMONGO_LIVE !== "on") throw new BadRequestException("Live mode needs PayMongo business verification, which is not switched on here. Use a test key (sk_test_) for now.");
    await checkPaymongoKey(body.secretKey, this.urls).catch(asBadRequest);
    const old = await connectionCredential(this.db, this.config.secretsKey, user.workspaceId, "paymongo");
    const webhookPath = old?.destination?.webhookPath ?? randomBytes(32).toString("base64url");
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "paymongo", {
      account: `${mode === "live" ? "Live" : "Test"} mode key`,
      credential: JSON.stringify({ secretKey: body.secretKey, webhookSecret: body.webhookSecret }),
      destination: { webhookPath, mode },
    });
    return this.get(user);
  }

  @Post("paymongo/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testPaymongo(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "paymongo");
    return this.test(user.workspaceId, "paymongo", conn, () => checkPaymongoKey((JSON.parse(conn.credential) as { secretKey: string }).secretKey, this.urls));
  }

  /** Connect or Reconnect Airtable: a read of one record proves the token, base and table. The token is never returned. */
  @Put("airtable")
  @UseGuards(RateLimit(10))
  async putAirtable(@CurrentUser() user: SessionUser, @Body(new ZodPipe(airtableInput)) body: z.output<typeof airtableInput>) {
    const destination = await airtableCheck(this.urls, body.token, body.baseId, body.tableId).catch(asBadRequest);
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "airtable", { account: body.baseId, credential: body.token, destination });
    return this.get(user);
  }

  /** A record needs field names Daloy does not know, so this repeats the read check instead of adding a row. */
  @Post("airtable/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testAirtable(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "airtable");
    return this.test(user.workspaceId, "airtable", conn, () => airtableCheck(this.urls, conn.credential, conn.destination!.baseId!, conn.destination!.tableId!));
  }

  /** Connect or Reconnect Notion: the database must be shared with the integration; its title property is found and saved. */
  @Put("notion")
  @UseGuards(RateLimit(10))
  async putNotion(@CurrentUser() user: SessionUser, @Body(new ZodPipe(notionInput)) body: z.output<typeof notionInput>) {
    const destination = await notionDatabase(this.urls, body.token, body.database).catch(asBadRequest);
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "notion", { account: destination.databaseTitle, credential: body.token, destination });
    return this.get(user);
  }

  /** Adds a page that only has a title, which every database accepts. */
  @Post("notion/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testNotion(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "notion");
    return this.test(user.workspaceId, "notion", conn, () => notionAddPage(this.urls, conn.credential, conn.destination as { databaseId: string; titleProperty: string }, "Test page from Daloy. You can delete this page.", {}));
  }

  /** Connect or Reconnect Trello: the key and token are saved together as one secret, never returned. */
  @Put("trello")
  @UseGuards(RateLimit(10))
  async putTrello(@CurrentUser() user: SessionUser, @Body(new ZodPipe(trelloInput)) body: z.output<typeof trelloInput>) {
    const cred = { key: body.key, token: body.token };
    const { account } = await trelloIdentity(this.urls, cred).catch(asBadRequest);
    const destination = await trelloList(this.urls, cred, body.listId).catch(asBadRequest);
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "trello", { account, credential: JSON.stringify(cred), destination });
    return this.get(user);
  }

  @Post("trello/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testTrello(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "trello");
    return this.test(user.workspaceId, "trello", conn, () => trelloAddCard(this.urls, JSON.parse(conn.credential), conn.destination!.listId!, "Test card from Daloy. You can archive this card.", ""));
  }

  @Get("slack/channels")
  @UseGuards(RateLimit(20))
  async channels(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "slack");
    return slackChannels(this.urls, slackToken(conn)).catch(asBadRequest);
  }

  @Put("slack/channel")
  @HttpCode(204)
  async putChannel(@CurrentUser() user: SessionUser, @Body(new ZodPipe(channelInput)) body: z.output<typeof channelInput>) {
    const conn = await this.connection(user.workspaceId, "slack");
    const channel = (await slackChannels(this.urls, slackToken(conn)).catch(asBadRequest)).find((c) => c.id === body.channelId);
    if (!channel) throw new BadRequestException("That channel is not in the list. Refresh the channel list and pick again.");
    await setDestination(this.db, user.workspaceId, "slack", { channelId: channel.id, channelName: channel.name });
  }

  @Post("slack/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testSlack(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "slack");
    return this.test(user.workspaceId, "slack", conn, () => slackPost(this.urls, slackToken(conn), conn.destination!.channelId!, "Test message from Daloy. Office requests will be posted here."));
  }

  /** Connect or Reconnect Outlook, from before the shared start route (decision 0058): the same flow as outlook/oauth/start. */
  @Post("outlook/start")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  startOutlook(@CurrentUser() user: SessionUser) {
    return startOAuth(this.db, this.config, outlook, user);
  }

  /** Sends a test email from the connected mailbox to itself, so nobody else receives it. */
  @Post("outlook/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testOutlook(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "outlook");
    const copy = builtInEmailCopy(user.language);
    // force: a test proves the grant itself still works, not only an access token that has not expired yet.
    return this.test(user.workspaceId, "outlook", conn, () =>
      withFreshToken(this.db, this.config.secretsKey, this.urls, user.workspaceId, outlook, conn, (token) => outlookSend(this.urls, token, { to: conn.account, subject: copy.outlookSubject, text: copy.outlookBody }), { force: true }),
    );
  }

  /** Connect, Reconnect or Replace link for Teams: the URL of a Teams workflow that posts to one channel. */
  @Put("teams")
  @UseGuards(RateLimit(10))
  async putTeams(@CurrentUser() user: SessionUser, @Body(new ZodPipe(teamsInput)) body: z.output<typeof teamsInput>) {
    const url = teamsWebhookUrl(this.urls, body.url);
    if (!url) throw new BadRequestException("Paste the link Teams shows after you create the workflow. It starts with https:// and ends in logic.azure.com or powerplatform.com.");
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "teams", { account: body.channelName, credential: url, destination: { channelName: body.channelName } });
    return this.get(user);
  }

  @Post("teams/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testTeams(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "teams");
    return this.test(user.workspaceId, "teams", conn, () => teamsPost(this.urls, conn.credential, "Test message from Daloy. Approved purchase requests will be noted in this channel."));
  }

  /**
   * Disconnect: deletes the stored credential. Queued deliveries fail with "not connected" and keep their payload for
   * Retry. An OAuth grant is then revoked at the provider (decision 0058): 200 with { revoked } says whether that
   * worked. 204 when there was nothing to revoke there, as before.
   */
  @Delete(":provider")
  async remove(@CurrentUser() user: SessionUser, @Param("provider", providerSlug) provider: Provider, @Res({ passthrough: true }) res: Response) {
    const def = this.config.oauthProviders.find((d) => d.provider === provider);
    const out = def ? await disconnectOAuth(this.db, this.config.secretsKey, this.urls, user.workspaceId, def) : { removed: await removeConnection(this.db, user.workspaceId, provider), revoked: null };
    if (!out.removed) throw new NotFoundException();
    if (out.revoked === null) return void res.status(204);
    return { revoked: out.revoked };
  }

  private async connection(userId: string, provider: Provider) {
    const conn = await connectionCredential(this.db, this.config.secretsKey, userId, provider);
    if (!conn) throw new NotFoundException(`${PROVIDER_NAMES[provider]} is not connected.`);
    return conn;
  }

  /** ok: true means the provider accepted the write. A rejected credential marks the connection failed, as a delivery would. */
  // conn is the connection the test sends with, so its result only touches that credential (Astra, 8e2c5d8).
  private async test(userId: string, provider: Provider, conn: { destination: Record<string, string> | null; revision: string }, send: () => Promise<Record<string, string | boolean>>) {
    if (!conn.destination) return { ok: false, error: provider === "google_sheets" ? "Pick a sheet first." : "Pick a channel first." };
    try {
      const result = await send();
      await markConnectionWorking(this.db, userId, provider, conn.revision);
      return { ok: true, ...result };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === "auth") await markConnectionFailed(this.db, userId, provider, err.message, conn.revision);
      return { ok: false, error: err.message };
    }
  }
}

/** Activity for one run, and the operator's Retry, Post again and Mark as posted. */
@Controller("deliveries")
@UseGuards(SessionGuard, Allow(OPERATE))
export class DeliveriesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  @Get()
  async list(@CurrentUser() user: SessionUser, @Query("runId", uuid) runId: string) {
    const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
    return (await listDeliveries(this.db, user.workspaceId, [runId])).map((d) => ({ ...d, lastError: hide(d.lastError), result: hide(d.result) }));
  }

  /** Queues a failed delivery again (the worker sends it within seconds). postAgain repeats a Slack post that may be in the channel already. */
  @Post(":id/retry")
  @HttpCode(204)
  @UseGuards(RateLimit(30))
  async retry(@CurrentUser() user: SessionUser, @Param("id", uuid) id: string, @Body(new ZodPipe(retryInput)) body: z.output<typeof retryInput>) {
    if (await retryDelivery(this.db, user.workspaceId, id, body)) return;
    if (await deliveryBookingMoved(this.db, user.workspaceId, id)) throw new ConflictException(BOOKING_CHANGED);
    await this.conflict(user.workspaceId, id);
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
