import { builtInEmailCopy } from "@daloy/engine";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendRow,
  consentOutcome,
  confirmDelivery,
  connectionCredential,
  deliveries,
  listDeliveries,
  markConnectionFailed,
  markConnectionWorking,
  outlookAdminConsentUrl,
  outlookAuthorizeUrl,
  outlookCodeTokens,
  outlookMailbox,
  outlookSend,
  PROVIDER_NAMES,
  ProviderError,
  readConnections,
  removeConnection,
  retryDelivery,
  BOOKING_CHANGED,
  deliveryBookingMoved,
  saveConnection,
  serviceAccountSchema,
  setDestination,
  sheetInfo,
  slackChannels,
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
  rotateInto,
  type Db,
  type Provider,
  type ProviderUrls,
  type ServiceAccount,
  type SheetDestination,
} from "@daloy/db";
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, Req, Res, UseGuards } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import type { Request, Response } from "express";
import { SessionGuard, sessionUser } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, RateLimit, ZodPipe, type ApiConfig, type SessionUser, MANAGE, OPERATE } from "./http";

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
// Airtable: a personal access token (pat...), a base id (app...) and a table id (tbl...) or name. Notion: an internal
// integration token and a database id (or the link to it). Trello: the API key, a token, and a list id (decision 0044).
const airtableInput = z.strictObject({
  token: z.string().trim().regex(/^pat[A-Za-z0-9]+\.[A-Za-z0-9]{20,100}$/, "Paste the personal access token, which starts with pat"),
  baseId: z.string().trim().regex(/^app[A-Za-z0-9]{10,30}$/, "The base id starts with app"),
  tableId: z.string().trim().regex(/^[^/?#\\]{1,100}$/, "Enter the table id (tbl...) or the table name"),
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
const retryInput = z.strictObject({ postAgain: z.boolean().default(false) });
const teamsInput = z.strictObject({ url: z.string().trim().min(10).max(2000), channelName: z.string().trim().min(1).max(100) });
const SLUGS: Record<string, Provider> = { "google-sheets": "google_sheets", slack: "slack", outlook: "outlook", teams: "teams", telegram: "telegram", airtable: "airtable", notion: "notion", trello: "trello" };
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
    const outlook = this.urls.microsoft ? { configured: true, adminConsentUrl: outlookAdminConsentUrl(this.urls, outlookRedirectUri(this.config)) } : { configured: false };
    return { connections: await readConnections(this.db, user.workspaceId), outlook };
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
    return this.test(user.workspaceId, "google_sheets", conn, () =>
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
    return this.test(user.workspaceId, "slack", conn, () => slackPost(this.urls, conn.credential, conn.destination!.channelId!, "Test message from Daloy. Office requests will be posted here."));
  }

  /**
   * Connect or Reconnect Outlook: the page sends the browser to this URL, Microsoft asks the owner (or tells them an
   * administrator must approve), and comes back to the callback below. The state is signed, so nothing is stored here.
   */
  @Post("outlook/start")
  @HttpCode(200)
  @UseGuards(RateLimit(10))
  startOutlook(@CurrentUser() user: SessionUser) {
    if (!this.urls.microsoft) throw new BadRequestException("Outlook is not set up on this installation. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.");
    const state = signState(this.config.secretsKey, { w: user.workspaceId, m: user.id, e: Date.now() + STATE_TTL_MS, n: randomBytes(12).toString("base64url") });
    const codeChallenge = createHash("sha256").update(pkceVerifier(this.config.secretsKey, state)).digest("base64url");
    return { url: outlookAuthorizeUrl(this.urls, { redirectUri: outlookRedirectUri(this.config), state, codeChallenge }) };
  }

  /** Sends a test email from the connected mailbox to itself, so nobody else receives it. */
  @Post("outlook/test")
  @HttpCode(200)
  @UseGuards(RateLimit(5))
  async testOutlook(@CurrentUser() user: SessionUser) {
    const conn = await this.connection(user.workspaceId, "outlook");
    const save = rotateInto(this.db, this.config.secretsKey, user.workspaceId, "outlook", conn);
    const copy = builtInEmailCopy(user.language);
    return this.test(user.workspaceId, "outlook", conn, () =>
      outlookSend(this.urls, conn.credential, save, { to: conn.account, subject: copy.outlookSubject, text: copy.outlookBody }),
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

  /** Disconnect: deletes the stored credential. Queued deliveries fail with "not connected" and keep their payload for Retry. */
  @Delete(":provider")
  @HttpCode(204)
  async remove(@CurrentUser() user: SessionUser, @Param("provider", providerSlug) provider: Provider) {
    if (!(await removeConnection(this.db, user.workspaceId, provider))) throw new NotFoundException();
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

const STATE_TTL_MS = 10 * 60_000;
type ConsentState = { w: string; m: string; e: number; n: string };
const mac = (key: Buffer, label: string, data: string) => createHmac("sha256", key).update(`${label}:${data}`).digest("base64url");
export const outlookRedirectUri = (config: Required<ApiConfig>) => `${config.publicUrl}/settings/connections/outlook/callback`;

/** The consent state: who started it and until when, signed with the secrets key so the callback can trust it. */
export function signState(key: Buffer, s: ConsentState) {
  const payload = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${payload}.${mac(key, "outlook-state", payload)}`;
}
export function readState(key: Buffer, state: string): ConsentState | null {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const want = Buffer.from(mac(key, "outlook-state", payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as ConsentState;
  return s.e > Date.now() ? s : null;
}
/** The PKCE verifier, derived from the signed state, so it needs no storage and only this installation can make it. */
const pkceVerifier = (key: Buffer, state: string) => mac(key, "outlook-pkce", state);

/**
 * Where Microsoft sends the browser back. Not behind SessionGuard, because an administrator who approves Daloy for the
 * organization usually has no Daloy session. Swapping a code for tokens still needs the signed-in owner who started it.
 * The page learns the outcome from a short code in the address, never from Microsoft's text.
 */
@Controller("settings/connections/outlook")
export class OutlookCallbackController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Required<ApiConfig>,
  ) {}

  @Get("callback")
  async callback(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, unknown>) {
    const done = (outcome: string) => res.redirect(302, `/#/settings/business/outlook-${outcome}`);
    const str = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
    if (str("admin_consent")) return done(str("admin_consent").toLowerCase() === "true" ? "admin_approved" : "admin_required");
    if (str("error")) return done(consentOutcome(str("error"), str("error_description")));
    const state = readState(this.config.secretsKey, str("state"));
    const user = await sessionUser(this.db, req);
    if (!state || !user || user.id !== state.m || user.workspaceId !== state.w || !MANAGE.includes(user.role)) return done("expired");
    try {
      const tokens = await outlookCodeTokens(this.config.providers, str("code"), pkceVerifier(this.config.secretsKey, str("state")), outlookRedirectUri(this.config));
      const mailbox = await outlookMailbox(this.config.providers, tokens.accessToken);
      await saveConnection(this.db, this.config.secretsKey, state.w, "outlook", { account: mailbox, credential: tokens.refreshToken, destination: { mailbox } });
      return done("connected");
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      return done("failed");
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
