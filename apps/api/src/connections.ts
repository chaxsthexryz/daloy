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
  metaIdentity,
  checkShopifyConnection,
  ensureOrderWebhook,
  normalizeShopDomain,
  parseShopifyCredential,
  removeOrderWebhook,
  shopifyConn,
  type ShopifyCredential,
  parseMetaCredential,
  paymongoMode,
  PROVIDER_NAMES,
  payments,
  ProviderError,
  readConnections,
  sharedGrants,
  sharedGoogleApps,
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
  airtableSchemaCheck,
  trelloAuthOf,
  withRecordAuth,
  notionAddPage,
  notionDatabase,
  trelloAddCard,
  trelloIdentity,
  trelloList,
  telegramChat,
  telegramChats,
  telegramIdentity,
  telegramSend,
  telegramSetWebhook,
  telegramDeleteWebhook,
  telegramWebhookSecret,
  spreadsheetIdFrom,
  discordPost,
  discordWebhookUrl,
  teamsPost,
  teamsWebhookUrl,
  type Db,
  type Provider,
  type ProviderUrls,
  type ServiceAccount,
  type SheetDestination,
} from "@daloy/db";
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, Res, UseGuards } from "@nestjs/common";
import { and, eq, desc, sql } from "drizzle-orm";
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
/** For best-effort calls such as removing a webhook: a provider's refusal is ignored, anything else is a real error. */
const ignoreProviderError = (err: unknown) => {
  if (!(err instanceof ProviderError)) throw err;
};
const telegramInput = z.strictObject({
  token: z.string().trim().regex(/^\d{6,12}:[A-Za-z0-9_-]{30,50}$/, "Paste the bot token from BotFather, like 123456789:AA..."),
  chatId: z.string().trim().regex(/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/, "Enter the chat id (a number) or the public @name"),
  // T9: Telegram sends the bot's new messages to kymavo, for the Telegram message trigger.
  receive: z.boolean().optional(),
});
const telegramChatsInput = z.strictObject({ token: telegramInput.shape.token });
// PayMongo's secret key and the signing secret of the webhook the owner made in PayMongo. Both are kept encrypted and never returned.
// The secret may come second: the webhook URL only exists after the key is saved, and until the secret is saved every paid event is refused (decision 0059).
const paymongoInput = z.strictObject({
  secretKey: z.string().trim().regex(/^sk_(test|live)_\S+$/, "Paste the secret key from PayMongo, which starts with sk_test_ or sk_live_"),
  webhookSecret: z.string().trim().regex(/^whsk_\S+$/, "Paste the webhook secret from PayMongo, which starts with whsk_").optional(),
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
const discordInput = teamsInput;
const metaMessengerInput = z.strictObject({
  pageId: z.string().trim().regex(/^\d{5,30}$/, "Enter the numeric Facebook Page ID"),
  instagramAccountId: z
    .string()
    .trim()
    .regex(/^(\d{5,30})?$/, "Enter the numeric Instagram Business Account ID")
    .optional()
    .transform((v) => (v ? v : undefined)),
  pageAccessToken: z.string().trim().min(10, "Paste the Meta Page Access Token").max(1000),
  appSecret: z.string().trim().min(8, "Paste the Meta App Secret").max(200).optional(),
  verifyToken: z.string().trim().min(6, "Enter a Verify Token of at least 6 characters").max(200).optional(),
});
// Shopify (decision 0105): the shop domain, the owner's own app's client secret (it signs the order webhook), and either
// the app's client ID (an app made in the Dev Dashboard, which gets 24-hour tokens) or the Admin API access token of an
// app made in the store admin before Shopify closed that. The shop is checked by normalizeShopDomain, so nothing but a
// *.myshopify.com host can ever receive the secret or a token.
const shopifyInput = z
  .strictObject({
    shop: z.string().trim().min(1, "Enter your shop domain, like your-shop.myshopify.com").max(300),
    clientId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,200}$/, "Paste the client ID from the app's Settings in the Dev Dashboard").optional(),
    accessToken: z.string().trim().min(10, "Paste the Admin API access token, which starts with shpat_").max(500).optional(),
    appSecret: z.string().trim().min(8, "Paste the app's client secret").max(200).optional(),
  })
  .refine((b) => (b.clientId === undefined) !== (b.accessToken === undefined), { message: "Paste the app's client ID, or the access token of an older app, but not both", path: ["clientId"] });
const SLUGS: Record<string, Provider> = { shopify: "shopify", "google-sheets": "google_sheets", slack: "slack", outlook: "outlook", teams: "teams", discord: "discord", telegram: "telegram", "google-calendar": "google_calendar", "google-drive": "google_drive", paymongo: "paymongo", airtable: "airtable", notion: "notion", trello: "trello", unisms: "unisms", "meta-messenger": "meta_messenger" };
const providerSlug = new ZodPipe(z.enum(Object.keys(SLUGS) as [string, ...string[]]).transform((s) => SLUGS[s]!));
const uuid = new ZodPipe(z.uuid());

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

  /** A provider's answer as a 400 the console can show, with workspace secrets hidden. Anything else is a real error. */
  private asBadRequest(workspaceId: string) {
    return async (err: unknown): Promise<never> => {
      if (!(err instanceof ProviderError)) throw err;
      const hide = await historyHider(this.db, this.config.secretsKey, workspaceId);
      throw new BadRequestException(hide(err.message) as string);
    };
  }

  @Get()
  async get(@CurrentUser() user: SessionUser) {
    const ms = this.urls.microsoft ? { configured: true, adminConsentUrl: outlookAdminConsentUrl(this.urls, redirectUri(this.config.publicUrl, outlook)) } : { configured: false };
    // The providers with a Connect button: their client is configured on this installation (decision 0058).
    const oauth = this.config.oauthProviders.filter((d) => d.client(this.urls)).map((d) => d.slug);
    const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
    const list = (await readConnections(this.db, user.workspaceId)).map((c) => ({ ...c, lastError: hide(c.lastError) as string | null }));
    // Only the currently published definition counts. Draft versions can contain abandoned destinations.
    const used = await this.db.execute<{ id: string; name: string; kind: string }>(sql`
      with current_versions as (
        select distinct on (w.id) w.id, w.name, v.definition
        from workflows w join workflow_versions v on v.workflow_id = w.id
        where w.user_id = ${user.workspaceId} and v.published
        order by w.id, v.version desc
      )
      select distinct id, name, item->>'type' as kind from current_versions
      cross join lateral jsonb_array_elements(definition->'steps') as item
      union select id, name, 'paymongo_link' from current_versions where definition->'trigger'->>'type' = 'payment'
      union select id, name, 'meta_messenger' from current_versions where definition->'trigger'->>'type' = 'meta_dm'
      union select id, name, 'shopify' from current_versions where definition->'trigger'->>'type' = 'shopify_order'
      union select id, name, 'telegram' from current_versions where definition->'trigger'->>'type' = 'telegram_message'
      order by name, id`);
    const providerFor: Record<string, string> = { email: "gmail", sheets: "google_sheets", drive: "google_drive", calendar: "google_calendar", paymongo_link: "paymongo", payment_status: "paymongo", sms: "unisms", meta_reply: "meta_messenger", shopify_create_product: "shopify", shopify_update_product: "shopify", google_docs: "google_drive" };
    const usage: Record<string, { id: string; name: string }[]> = {};
    const supported = new Set(["gmail", ...Object.keys(PROVIDER_NAMES)]);
    for (const { id, name, kind } of used.rows) {
      const key = providerFor[kind] ?? kind;
      if (!supported.has(key)) continue;
      const entries = usage[key] ??= [];
      if (!entries.some((entry) => entry.id === id)) entries.push({ id, name });
    }
    const [latestPayment] = await this.db.select({ status: payments.status, updatedAt: payments.updatedAt, live: payments.livemode })
      .from(payments).where(eq(payments.userId, user.workspaceId)).orderBy(desc(payments.updatedAt), desc(payments.id)).limit(1);
    return { connections: list, outlook: ms, oauth, usage, latestPayment: latestPayment ?? null, shared: await sharedGrants(this.db, user.workspaceId), sharedGoogleApps: await sharedGoogleApps(this.db, user.workspaceId), paymongoWebhookBase: `${this.config.publicUrl}/hooks/paymongo`, shopifyWebhookBase: `${this.config.publicUrl}/hooks/shopify`, metaWebhookBase: `${this.config.publicUrl}/hooks/meta` };
  }

  /** The sheet and tab, checked with a read before saving. Shared by connect and "change sheet". */
  private async destination(workspaceId: string, sa: ServiceAccount, input: z.output<typeof destinationInput>) {
    const spreadsheetId = spreadsheetIdFrom(input.sheet);
    if (!spreadsheetId) throw new BadRequestException("Paste the sheet's link from the browser address bar.");
    const info = await sheetInfo(this.urls, sa, spreadsheetId).catch(this.asBadRequest(workspaceId));
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
    const destination = await this.destination(user.workspaceId, sa, body);
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
    await setDestination(this.db, user.workspaceId, "google_sheets", await this.destination(user.workspaceId, JSON.parse(conn.credential) as ServiceAccount, body));
  }

  /** Adds a visible test row, which proves kymavo can write (a shared-as-viewer sheet passes the read check but fails here). */
  @Post("google-sheets/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testSheets(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "google_sheets");
    const stamp = new Date().toISOString();
    // force: with a Google sign-in, a test proves the grant itself still works (decision 0058).
    return this.test(user.workspaceId, "google_sheets", conn, () =>
      withGoogle(this.db, this.config.secretsKey, this.urls, user.workspaceId, "google_sheets", conn, (auth) => appendRow(this.urls, auth, conn.destination as SheetDestination, [`TEST-${stamp}`, stamp, "Test row from kymavo. You can delete this row."]), { force: true }),
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
    const { title } = await calendarInfo(this.urls, sa, calendarId).catch(this.asBadRequest(user.workspaceId));
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "google_calendar", { account: sa.client_email, credential: JSON.stringify({ client_email: sa.client_email, private_key: sa.private_key }), destination: { calendarId, title } });
    return this.get(user);
  }

  /** Makes and removes a test event, which proves kymavo can write. */
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
    const { title } = await driveFolderInfo(this.urls, sa, folderId).catch(this.asBadRequest(user.workspaceId));
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "google_drive", { account: sa.client_email, credential: JSON.stringify({ client_email: sa.client_email, private_key: sa.private_key }), destination: { folderId, title } });
    return this.get(user);
  }

  /** Connect or Reconnect Slack with the app's bot token. A reconnect keeps the chosen channel. */
  @Put("slack")
  @UseGuards(RateLimit(10))
  async putSlack(@CurrentUser() user: SessionUser, @Body(new ZodPipe(slackInput)) body: z.output<typeof slackInput>) {
    const { team } = await slackIdentity(this.urls, body.token).catch(this.asBadRequest(user.workspaceId));
    const old = await connectionCredential(this.db, this.config.secretsKey, user.workspaceId, "slack");
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "slack", { account: team, credential: body.token, destination: old?.destination ?? null });
    return this.get(user);
  }

  /** Connect or Reconnect Telegram: the bot must work and see the chat, and both are saved together. The token is never returned. */
  @Put("telegram")
  @UseGuards(RateLimit(10))
  async putTelegram(@CurrentUser() user: SessionUser, @Body(new ZodPipe(telegramInput)) body: z.output<typeof telegramInput>) {
    const { bot } = await telegramIdentity(this.urls, body.token).catch(this.asBadRequest(user.workspaceId));
    const chat = await telegramChat(this.urls, body.token, body.chatId).catch(this.asBadRequest(user.workspaceId));
    const old = await connectionCredential(this.db, this.config.secretsKey, user.workspaceId, "telegram");
    let destination: Record<string, string> = chat;
    if (body.receive) {
      // T9 (decision 0117): the path is kept across reconnects; the secret is derived from the token, so a new token gets a new one.
      const webhookPath = old?.destination?.webhookPath ?? randomBytes(32).toString("base64url");
      const url = `${this.config.publicUrl}/hooks/telegram/${webhookPath}`;
      const webhook = await telegramSetWebhook(this.urls, body.token, url, telegramWebhookSecret(body.token, webhookPath)).then(
        () => "registered",
        (err: unknown) => {
          // Telegram only delivers to a public https address. The connection still sends; the Apps page says receiving failed.
          if (err instanceof ProviderError) return "failed";
          throw err;
        },
      );
      destination = { ...chat, webhookPath, webhook };
    } else if (old?.destination?.webhookPath) {
      await telegramDeleteWebhook(this.urls, old.credential).catch(ignoreProviderError);
    }
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "telegram", { account: bot, credential: body.token, destination });
    return this.get(user);
  }

  /** Wizard step: proves the token (getMe) and lists the chats the bot has recently seen, so the owner taps one. Nothing is saved or returned but the bot name and those chats. */
  @Post("telegram/chats")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  async telegramChatList(@CurrentUser() user: SessionUser, @Body(new ZodPipe(telegramChatsInput)) body: z.output<typeof telegramChatsInput>) {
    const { bot } = await telegramIdentity(this.urls, body.token).catch(this.asBadRequest(user.workspaceId));
    return { bot, ...(await telegramChats(this.urls, body.token).catch(this.asBadRequest(user.workspaceId))) };
  }

  @Post("telegram/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testTelegram(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "telegram");
    return this.test(user.workspaceId, "telegram", conn, () => telegramSend(this.urls, conn.credential, conn.destination!.chatId!, "Test message from kymavo."));
  }

  /** Connect or Reconnect PayMongo. The webhook path is made once and kept, so the URL given to PayMongo keeps working. */
  @Put("paymongo")
  @UseGuards(RateLimit(10))
  async putPaymongo(@CurrentUser() user: SessionUser, @Body(new ZodPipe(paymongoInput)) body: z.output<typeof paymongoInput>) {
    const mode = paymongoMode(body.secretKey);
    if (mode === "live" && process.env.PAYMONGO_LIVE !== "on") throw new BadRequestException("Live mode needs PayMongo business verification, which is not switched on here. Use a test key (sk_test_) for now.");
    await checkPaymongoKey(body.secretKey, this.urls).catch(this.asBadRequest(user.workspaceId));
    const old = await connectionCredential(this.db, this.config.secretsKey, user.workspaceId, "paymongo");
    const webhookPath = old?.destination?.webhookPath ?? randomBytes(32).toString("base64url");
    const webhookSecret = body.webhookSecret ?? (old ? (JSON.parse(old.credential) as { webhookSecret?: string }).webhookSecret : undefined) ?? "";
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "paymongo", {
      account: `${mode === "live" ? "Live" : "Test"} mode key`,
      credential: JSON.stringify({ secretKey: body.secretKey, webhookSecret }),
      destination: { webhookPath, mode, ...(webhookSecret ? {} : { webhookPending: "true" }) },
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
    const destination = await airtableCheck(this.urls, body.token, body.baseId, body.tableId).catch(this.asBadRequest(user.workspaceId));
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "airtable", { account: body.baseId, credential: body.token, destination });
    return this.get(user);
  }

  /** A record needs field names kymavo does not know, so this repeats the read check instead of adding a row. */
  @Post("airtable/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testAirtable(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "airtable");
    // An OAuth grant has no record read scope, so it checks the schema instead. force: the test proves the grant itself.
    return this.test(user.workspaceId, "airtable", conn, () => this.auth(user, "airtable", conn, (t) => (conn.authMethod === "oauth" ? airtableSchemaCheck : airtableCheck)(this.urls, t, conn.destination!.baseId!, conn.destination!.tableId!)));
  }

  /** Connect or Reconnect Notion: the database must be shared with the integration; its title property is found and saved. */
  @Put("notion")
  @UseGuards(RateLimit(10))
  async putNotion(@CurrentUser() user: SessionUser, @Body(new ZodPipe(notionInput)) body: z.output<typeof notionInput>) {
    const destination = await notionDatabase(this.urls, body.token, body.database).catch(this.asBadRequest(user.workspaceId));
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "notion", { account: destination.databaseTitle, credential: body.token, destination });
    return this.get(user);
  }

  /** Adds a page that only has a title, which every database accepts. */
  @Post("notion/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testNotion(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "notion");
    return this.test(user.workspaceId, "notion", conn, () => this.auth(user, "notion", conn, (t) => notionAddPage(this.urls, t, conn.destination as { databaseId: string; titleProperty: string }, "Test page from kymavo. You can delete this page.", {})));
  }

  /** Connect or Reconnect Trello: the key and token are saved together as one secret, never returned. */
  @Put("trello")
  @UseGuards(RateLimit(10))
  async putTrello(@CurrentUser() user: SessionUser, @Body(new ZodPipe(trelloInput)) body: z.output<typeof trelloInput>) {
    const cred = { key: body.key, token: body.token };
    const { account } = await trelloIdentity(this.urls, cred).catch(this.asBadRequest(user.workspaceId));
    const destination = await trelloList(this.urls, cred, body.listId).catch(this.asBadRequest(user.workspaceId));
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "trello", { account, credential: JSON.stringify(cred), destination });
    return this.get(user);
  }

  @Post("trello/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testTrello(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "trello");
    return this.test(user.workspaceId, "trello", conn, () => this.auth(user, "trello", conn, (t) => trelloAddCard(this.urls, trelloAuthOf(conn.authMethod, t), conn.destination!.listId!, "Test card from kymavo. You can archive this card.", "")));
  }

  @Get("slack/channels")
  @UseGuards(RateLimit(20))
  async channels(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "slack");
    return slackChannels(this.urls, slackToken(conn)).catch(this.asBadRequest(user.workspaceId));
  }

  @Put("slack/channel")
  @HttpCode(204)
  async putChannel(@CurrentUser() user: SessionUser, @Body(new ZodPipe(channelInput)) body: z.output<typeof channelInput>) {
    const conn = await this.connection(user.workspaceId, "slack");
    const channel = (await slackChannels(this.urls, slackToken(conn)).catch(this.asBadRequest(user.workspaceId))).find((c) => c.id === body.channelId);
    if (!channel) throw new BadRequestException("That channel is not in the list. Refresh the channel list and pick again.");
    await setDestination(this.db, user.workspaceId, "slack", { channelId: channel.id, channelName: channel.name });
  }

  @Post("slack/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testSlack(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "slack");
    return this.test(user.workspaceId, "slack", conn, () => slackPost(this.urls, slackToken(conn), conn.destination!.channelId!, "Test message from kymavo. Office requests will be posted here."));
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
    return this.test(user.workspaceId, "teams", conn, () => teamsPost(this.urls, conn.credential, "Test message from kymavo. Approved purchase requests will be noted in this channel."));
  }

  /** Connect, Reconnect or Replace link for Discord: a webhook URL from the channel's Integrations settings. The URL is a credential, so it is stored encrypted and never returned. */
  @Put("discord")
  @UseGuards(RateLimit(10))
  async putDiscord(@CurrentUser() user: SessionUser, @Body(new ZodPipe(discordInput)) body: z.output<typeof discordInput>) {
    const url = discordWebhookUrl(this.urls, body.url);
    if (!url) throw new BadRequestException("Paste the webhook link Discord shows in the channel's Integrations settings. It starts with https://discord.com/api/webhooks/.");
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "discord", { account: body.channelName, credential: url, destination: { channelName: body.channelName } });
    return this.get(user);
  }

  @Post("discord/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testDiscord(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "discord");
    return this.test(user.workspaceId, "discord", conn, () => discordPost(this.urls, conn.credential, "Test message from kymavo. Your automations can post to this channel."));
  }

  /** Connect or Reconnect Facebook Messenger and Instagram DM. Preserves existing webhookPath across updates. */
  @Put("meta-messenger")
  @UseGuards(RateLimit(10))
  async putMetaMessenger(@CurrentUser() user: SessionUser, @Body(new ZodPipe(metaMessengerInput)) body: z.output<typeof metaMessengerInput>) {
    const old = await connectionCredential(this.db, this.config.secretsKey, user.workspaceId, "meta_messenger");
    const oldCred = old ? parseMetaCredential(old.credential) : null;
    const appSecret = body.appSecret ?? oldCred?.appSecret;
    const verifyToken = body.verifyToken ?? oldCred?.verifyToken;
    if (!appSecret) throw new BadRequestException("Paste the Meta App Secret.");
    if (!verifyToken) throw new BadRequestException("Enter a Verify Token of at least 6 characters.");
    const page = await metaIdentity(this.urls, body.pageAccessToken).catch(this.asBadRequest(user.workspaceId));
    if (page.id !== body.pageId) {
      throw new BadRequestException(`The Page Access Token belongs to Facebook Page ${page.id}, which does not match Page ID ${body.pageId}.`);
    }
    if (body.instagramAccountId && page.instagramAccountId && page.instagramAccountId !== body.instagramAccountId) {
      throw new BadRequestException(`The Page Access Token is linked to Instagram Business Account ${page.instagramAccountId}, which does not match ${body.instagramAccountId}.`);
    }
    const webhookPath = old?.destination?.webhookPath ?? randomBytes(32).toString("base64url");
    const destination: Record<string, string> = {
      pageId: body.pageId,
      ...(page.name ? { pageName: page.name } : {}),
      ...(body.instagramAccountId ? { instagramAccountId: body.instagramAccountId } : {}),
      webhookPath,
    };
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "meta_messenger", {
      account: page.name || body.pageId,
      credential: JSON.stringify({ pageAccessToken: body.pageAccessToken, appSecret, verifyToken }),
      destination,
    });
    return { ...(await this.get(user)), webhookUrl: `${this.config.publicUrl}/hooks/meta/${webhookPath}`, status: "active" as const };
  }

  @Post("meta-messenger/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testMetaMessenger(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "meta_messenger");
    return this.test(user.workspaceId, "meta_messenger", conn, async () => {
      const { pageAccessToken } = parseMetaCredential(conn.credential);
      const info = await metaIdentity(this.urls, pageAccessToken);
      if (conn.destination?.pageId && info.id !== conn.destination.pageId) {
        throw new ProviderError("The Page Access Token no longer matches the connected Facebook Page ID.", "auth");
      }
      if (conn.destination?.instagramAccountId && info.instagramAccountId && info.instagramAccountId !== conn.destination.instagramAccountId) {
        throw new ProviderError("The Page Access Token no longer matches the connected Instagram Business Account ID.", "auth");
      }
      return { pageId: info.id, pageName: info.name };
    });
  }

  /**
   * Connect or Reconnect Shopify (decision 0105). The shop and token are checked with one read call, which also lists the
   * scopes the app lacks. orders/create is then registered at kymavo's address for this workspace. If Shopify refuses the
   * webhook (it only delivers to a public https address) the connection is still saved and the answer says why.
   * The path of the address and the app secret are kept when the token is replaced.
   */
  @Put("shopify")
  @UseGuards(RateLimit(10))
  async putShopify(@CurrentUser() user: SessionUser, @Body(new ZodPipe(shopifyInput)) body: z.output<typeof shopifyInput>) {
    const shop = normalizeShopDomain(body.shop);
    if (!shop) throw new BadRequestException("That is not a Shopify shop domain. It looks like your-shop.myshopify.com (Shopify admin, Settings, Domains).");
    const old = await connectionCredential(this.db, this.config.secretsKey, user.workspaceId, "shopify");
    const oldCred = old ? parseShopifyCredential(old.credential) : null;
    // A saved secret is only kept for the same app: the same client ID, or another token of an older app.
    const sameApp = oldCred && (body.clientId !== undefined ? oldCred.clientId === body.clientId : oldCred.accessToken !== undefined);
    const appSecret = body.appSecret ?? (sameApp ? oldCred.appSecret : undefined);
    if (!appSecret) throw new BadRequestException("Paste the app's client secret. kymavo uses it to check that orders really come from Shopify.");
    const cred: ShopifyCredential = body.clientId !== undefined ? { appSecret, clientId: body.clientId } : { appSecret, accessToken: body.accessToken! };
    const conn = await shopifyConn(this.urls, shop, cred).catch(this.asBadRequest(user.workspaceId));
    const info = await checkShopifyConnection(this.urls, conn).catch(this.asBadRequest(user.workspaceId));
    const webhookPath = old?.destination?.webhookPath ?? randomBytes(32).toString("base64url");
    const base = `${this.config.publicUrl}/hooks/shopify/`;
    const webhook = await ensureOrderWebhook(this.urls, conn, `${base}${webhookPath}`, base);
    await saveConnection(this.db, this.config.secretsKey, user.workspaceId, "shopify", {
      account: shop,
      credential: JSON.stringify(cred),
      destination: { shop, shopName: info.name, webhookPath, webhook: webhook.state, ...(webhook.state === "failed" ? { webhookError: webhook.message.slice(0, 300) } : {}) },
    });
    const hide = await historyHider(this.db, this.config.secretsKey, user.workspaceId);
    return { ...(await this.get(user)), webhookUrl: `${base}${webhookPath}`, webhook: webhook.state === "failed" ? { state: "failed", message: hide(webhook.message) as string } : webhook, shop: info.name, missingScopes: info.missingScopes, status: "active" as const };
  }

  @Post("shopify/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testShopify(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "shopify");
    return this.test(user.workspaceId, "shopify", conn, async () => {
      const shop = conn.destination?.shop ?? conn.account;
      const info = await checkShopifyConnection(this.urls, await shopifyConn(this.urls, shop, parseShopifyCredential(conn.credential)));
      return { shop: info.name, missingScopes: info.missingScopes.join(", "), webhook: conn.destination?.webhook ?? "unknown" };
    });
  }

  /**
   * Disconnect: deletes the stored credential. Queued deliveries fail with "not connected" and keep their payload for
   * Retry. An OAuth grant is then revoked at the provider (decision 0058): 200 with { revoked } says whether that
   * worked. 204 when there was nothing to revoke there, as before.
   */
  @Delete(":provider")
  async remove(@CurrentUser() user: SessionUser, @Param("provider", providerSlug) provider: Provider, @Res({ passthrough: true }) res: Response) {
    if (provider === "shopify") await this.dropShopifyWebhook(user.workspaceId);
    if (provider === "telegram") await this.dropTelegramWebhook(user.workspaceId);
    const def = this.config.oauthProviders.find((d) => d.provider === provider);
    const out = def ? await disconnectOAuth(this.db, this.config.secretsKey, this.urls, user.workspaceId, def) : { removed: await removeConnection(this.db, user.workspaceId, provider), revoked: null };
    if (!out.removed) throw new NotFoundException();
    if (out.revoked === null) return void res.status(204);
    return { revoked: out.revoked };
  }

  /** The record apps' calls: an OAuth access token (refreshed first, forced for a test) or the pasted credential (decision 0062). */
  private auth<T>(user: SessionUser, provider: Provider, conn: Awaited<ReturnType<ConnectionsController["connection"]>>, fn: (credential: string) => Promise<T>) {
    return withRecordAuth(this.db, this.config.secretsKey, this.urls, user.workspaceId, this.config.oauthProviders.find((d) => d.provider === provider), conn, fn, { force: true });
  }

  /** Best effort: takes kymavo's orders/create subscription out of the store before the token goes. Shopify drops a dead one after 8 failed deliveries anyway. */
  private async dropShopifyWebhook(workspaceId: string) {
    const conn = await connectionCredential(this.db, this.config.secretsKey, workspaceId, "shopify");
    if (!conn || conn.status !== "active") return;
    try {
      const shop = conn.destination?.shop ?? conn.account;
      await removeOrderWebhook(this.urls, await shopifyConn(this.urls, shop, parseShopifyCredential(conn.credential)), `${this.config.publicUrl}/hooks/shopify/`);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
    }
  }

  /** Best effort: the bot stops sending to kymavo and can list its chats again. The hook refuses calls once the row is gone anyway. */
  private async dropTelegramWebhook(workspaceId: string) {
    const conn = await connectionCredential(this.db, this.config.secretsKey, workspaceId, "telegram");
    if (conn?.destination?.webhookPath) await telegramDeleteWebhook(this.urls, conn.credential).catch(ignoreProviderError);
  }

  private async connection(userId: string, provider: Provider) {
    const conn = await connectionCredential(this.db, this.config.secretsKey, userId, provider);
    if (!conn) throw new NotFoundException(`${PROVIDER_NAMES[provider]} is not connected.`);
    return conn;
  }

  /** ok: true means the provider accepted the write. A rejected credential marks the connection failed, as a delivery would. */
  // conn is the connection the test sends with, so its result only touches that credential (Astra, 8e2c5d8).
  private async test(userId: string, provider: Provider, conn: { destination: Record<string, string> | null; revision: string }, send: () => Promise<Record<string, string | boolean>>) {
    if (!conn.destination) return { ok: false, error: `Pick a ${{ google_sheets: "sheet", airtable: "table", notion: "database", trello: "list" }[provider as string] ?? "channel"} first.` };
    try {
      const result = await send();
      await markConnectionWorking(this.db, userId, provider, conn.revision);
      return { ok: true, ...result };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === "auth") await markConnectionFailed(this.db, userId, provider, err.message, conn.revision);
      const hide = await historyHider(this.db, this.config.secretsKey, userId);
      return { ok: false, error: hide(err.message) as string };
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
    return (await listDeliveries(this.db, user.workspaceId, [runId])).map((d) => ({ ...d, reference: hide(d.reference) as string, lastError: hide(d.lastError), result: hide(d.result) }));
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
