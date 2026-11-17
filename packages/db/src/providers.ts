import { createHash, createSign } from "node:crypto";
import * as z from "zod";

/**
 * Google Sheets, Slack, Outlook (Microsoft Graph) and Teams Workflows, called with fetch. Every failure becomes a ProviderError whose kind says what the caller
 * should do (decision 0021):
 * - auth: the credential no longer works. Stop using the connection until the owner reconnects.
 * - permission: this destination refused (sheet not shared, app not in the channel). Fix it, then retry.
 * - quota, unavailable: try again later. retryAfterMs is the provider's own hint.
 * - ambiguous: a write timed out or broke after it was sent, so the provider may have done it.
 * - invalid: the request itself was wrong. Retrying the same thing will not help.
 * - review: Daloy cannot tell what happened and must not guess; a person decides.
 */
export type ProviderErrorKind = "auth" | "permission" | "quota" | "unavailable" | "ambiguous" | "invalid" | "review";
export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Where the providers live. The env vars exist so tests and the e2e suite can point at local fakes. */
export type ProviderUrls = {
  googleToken: string;
  sheets: string;
  slack: string;
  telegram: string;
  microsoftLogin?: string;
  graph?: string;
  /** Host suffixes a Teams Workflows URL may use. 127.0.0.1 (tests only) is the one host allowed over http. */
  teamsHosts?: string[];
  /** The installation's own Microsoft Entra app, for Outlook consent. Unset: Outlook is not offered (decision 0023). */
  microsoft?: { clientId: string; clientSecret: string; tenant: string };
  timeoutMs?: number;
};
const trim = (url: string) => url.replace(/\/+$/, "");
export const providerUrls = (env: NodeJS.ProcessEnv = process.env): ProviderUrls => ({
  googleToken: env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
  sheets: trim(env.GOOGLE_SHEETS_URL ?? "https://sheets.googleapis.com"),
  slack: trim(env.SLACK_API_URL ?? "https://slack.com"),
  telegram: trim(env.TELEGRAM_API_URL ?? "https://api.telegram.org"),
  microsoftLogin: trim(env.MICROSOFT_LOGIN_URL ?? "https://login.microsoftonline.com"),
  graph: trim(env.MICROSOFT_GRAPH_URL ?? "https://graph.microsoft.com"),
  teamsHosts: (env.TEAMS_WEBHOOK_HOSTS ?? "logic.azure.com,powerplatform.com").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  microsoft:
    env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
      ? { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tenant: env.MICROSOFT_TENANT || "organizations" }
      : undefined,
});

type Reply = { status: number; headers: Headers; body: Record<string, unknown> };

/**
 * One call with a timeout. For a write, a timeout or a dropped connection is ambiguous: the request may have arrived.
 * A refused connection or failed DNS lookup means it did not, so that is only "unavailable".
 */
async function call(url: string, init: RequestInit, timeoutMs: number, write: boolean, what: string): Promise<Reply> {
  try {
    const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    return { status: res.status, headers: res.headers, body };
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    const notSent = code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
    if (!write || notSent) throw new ProviderError(`${what} could not be reached. Daloy will try again.`, "unavailable");
    throw new ProviderError(`${what} did not answer in time, so Daloy cannot tell whether it went through.`, "ambiguous");
  }
}

const retryAfter = (headers: Headers) => {
  const s = Number(headers.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? s * 1000 : undefined;
};

// ---------------------------------------------------------------- Google Sheets

/** The fields Daloy needs from a service account key file. The rest of the file is ignored and not stored. */
export const serviceAccountSchema = z.object({
  client_email: z.email(),
  private_key: z.string().includes("PRIVATE KEY"),
});
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;
export type SheetDestination = { spreadsheetId: string; tab: string };

/** Takes a sheet link (https://docs.google.com/spreadsheets/d/<id>/edit) or the id itself. */
export function spreadsheetIdFrom(input: string): string | null {
  const id = /\/spreadsheets\/d\/([\w-]+)/.exec(input)?.[1] ?? input.trim();
  return /^[\w-]{10,100}$/.test(id) ? id : null;
}

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
// Access tokens by key, in memory. ponytail: per process, so the API and the worker each fetch their own; fine at this scale.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const cacheKey = (sa: ServiceAccount) => createHash("sha256").update(`${sa.client_email}\n${sa.private_key}`).digest("hex");

/** The OAuth JWT bearer grant for service accounts: a signed assertion swapped for a one-hour access token. */
async function accessToken(urls: ProviderUrls, sa: ServiceAccount): Promise<string> {
  const cached = tokenCache.get(cacheKey(sa));
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: sa.client_email, scope: SCOPE, aud: urls.googleToken, iat: now, exp: now + 3600 })}`;
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  } catch {
    throw new ProviderError("The service account key could not be read. Connect Google Sheets again with a new key file.", "auth");
  }
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` });
  const res = await call(urls.googleToken, { method: "POST", body }, urls.timeoutMs ?? 10_000, false, "Google sign-in");
  if (res.status === 400 || res.status === 401) {
    throw new ProviderError("Google rejected the service account key. It may have been deleted or disabled. Connect Google Sheets again.", "auth");
  }
  if (res.status !== 200 || typeof res.body.access_token !== "string") throw new ProviderError(`Google sign-in answered ${res.status}. Daloy will try again.`, "unavailable");
  const expiresIn = typeof res.body.expires_in === "number" ? res.body.expires_in : 3600;
  tokenCache.set(cacheKey(sa), { token: res.body.access_token, expiresAt: Date.now() + expiresIn * 1000 });
  return res.body.access_token;
}

function sheetsFailure(res: Reply, sa: ServiceAccount, write: boolean): ProviderError {
  const message = String((res.body.error as { message?: unknown } | undefined)?.message ?? "");
  const share = `Share the sheet with ${sa.client_email} as an Editor.`;
  if (res.status === 401) return new ProviderError("Google did not accept Daloy's access. Connect Google Sheets again.", "auth");
  if (res.status === 403) return new ProviderError(`Google Sheets refused access. ${share}${message ? ` Google said: ${message}` : ""}`, "permission");
  if (res.status === 404) return new ProviderError(`The spreadsheet was not found. Check the link, and ${share.charAt(0).toLowerCase()}${share.slice(1)}`, "permission");
  if (res.status === 429) return new ProviderError("Google Sheets is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers));
  // A server error on a write may still have written the row, so the next attempt looks first.
  if (res.status >= 500) return new ProviderError(`Google Sheets answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  return new ProviderError(`Google Sheets rejected the request${message ? `: ${message}` : ` (${res.status})`}.`, "invalid");
}

/** A Sheets API call with the cached token. A 401 drops the token and tries once with a new one (expired access). */
async function sheets(urls: ProviderUrls, sa: ServiceAccount, path: string, init: RequestInit, write: boolean): Promise<Record<string, unknown>> {
  for (let tries = 0; ; tries++) {
    const token = await accessToken(urls, sa);
    const res = await call(`${urls.sheets}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }, urls.timeoutMs ?? 10_000, write, "Google Sheets");
    if (res.status === 200) return res.body;
    if (res.status === 401 && tries === 0) {
      tokenCache.delete(cacheKey(sa));
      continue;
    }
    throw sheetsFailure(res, sa, write);
  }
}

// A tab name in A1 notation is quoted, with quotes doubled, so names with spaces or apostrophes work.
const range = (tab: string, cells: string) => encodeURIComponent(`'${tab.replaceAll("'", "''")}'!${cells}`);

/** The spreadsheet's title and tab names, to check access when connecting. Reads only. */
export async function sheetInfo(urls: ProviderUrls, sa: ServiceAccount, spreadsheetId: string) {
  const body = await sheets(urls, sa, `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`, {}, false);
  const tabs = ((body.sheets as { properties: { title: string } }[] | undefined) ?? []).map((s) => s.properties.title);
  return { title: String((body.properties as { title?: unknown } | undefined)?.title ?? ""), tabs };
}

/**
 * Adds the row under the last one in the tab. RAW keeps every value as typed, so form text such as "=IMPORTXML(...)"
 * is stored as text and never runs as a formula.
 */
export async function appendRow(urls: ProviderUrls, sa: ServiceAccount, dest: SheetDestination, row: string[]) {
  const path = `/v4/spreadsheets/${encodeURIComponent(dest.spreadsheetId)}/values/${range(dest.tab, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const body = await sheets(urls, sa, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: [row] }) }, true);
  return { range: String((body.updates as { updatedRange?: unknown } | undefined)?.updatedRange ?? "") };
}

/** A Sheets write's marker: a developer metadata id and value, chosen when the delivery is queued (decision 0021). */
export type SheetWriteKey = { id: number; value: string };
const MARKER_KEY = "daloy";
const json = { "content-type": "application/json" };

async function sheetIdOf(urls: ProviderUrls, sa: ServiceAccount, dest: SheetDestination): Promise<number> {
  const body = await sheets(urls, sa, `/v4/spreadsheets/${encodeURIComponent(dest.spreadsheetId)}?fields=sheets.properties(sheetId,title)`, {}, false);
  const tab = ((body.sheets as { properties: { sheetId: number; title: string } }[] | undefined) ?? []).find((s) => s.properties.title === dest.tab);
  if (!tab) throw new ProviderError(`The tab "${dest.tab}" is no longer in the spreadsheet. Pick the tab again in Apps, then retry.`, "invalid");
  return tab.properties.sheetId;
}

/** The value of our marker with this id, "" for someone else's metadata under that id, or null when there is none. */
async function markerAt(urls: ProviderUrls, sa: ServiceAccount, spreadsheetId: string, id: number): Promise<string | null> {
  try {
    const body = await sheets(urls, sa, `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/developerMetadata/${id}`, {}, false);
    return body.metadataKey === MARKER_KEY ? String(body.metadataValue ?? "") : "";
  } catch (err) {
    // 404 comes back as "permission" (spreadsheet or entry not found); the spreadsheet was just reachable, so: no entry.
    if (err instanceof ProviderError && err.kind === "permission") return null;
    throw err;
  }
}

/**
 * Adds the row unless its marker is already there. One spreadsheets.batchUpdate creates the marker (project-private
 * developer metadata with our chosen id) and appends the row. Google applies a batch entirely or not at all and refuses
 * a second marker with the same id, so while the marker exists a retry, a parallel attempt or a late copy of an earlier
 * request cannot add the row twice. Once the marker is deleted that no longer holds (decision 0021). A refused batch is
 * checked against the marker: ours means the row is already in. Cells are string values, never formulas.
 */
export async function appendRowOnce(urls: ProviderUrls, sa: ServiceAccount, dest: SheetDestination, row: string[], key: SheetWriteKey): Promise<{ sheet: string; reconciled?: true }> {
  const sheetId = await sheetIdOf(urls, sa, dest);
  const requests = [
    { createDeveloperMetadata: { developerMetadata: { metadataId: key.id, metadataKey: MARKER_KEY, metadataValue: key.value, location: { sheetId }, visibility: "PROJECT" } } },
    { appendCells: { sheetId, rows: [{ values: row.map((v) => ({ userEnteredValue: { stringValue: v } })) }], fields: "userEnteredValue" } },
  ];
  try {
    await sheets(urls, sa, `/v4/spreadsheets/${encodeURIComponent(dest.spreadsheetId)}:batchUpdate`, { method: "POST", headers: json, body: JSON.stringify({ requests }) }, true);
    return { sheet: dest.tab };
  } catch (err) {
    if (!(err instanceof ProviderError) || err.kind !== "invalid") throw err;
    const found = await markerAt(urls, sa, dest.spreadsheetId, key.id);
    if (found === key.value) return { sheet: dest.tab, reconciled: true };
    if (found !== null) throw new ProviderError(`Something else in this spreadsheet already uses Daloy's marker ${key.id}, so Daloy cannot tell whether this row was added. Check the sheet, then choose Mark as posted or Post again.`, "review");
    throw err;
  }
}

/**
 * Removes our marker once it is no longer needed (decision 0021: kept 24 hours after delivery). The filter names the id,
 * our key and our value, and Google deletes only metadata matching all three, so metadata another tool keeps under the
 * same id (a marker collision) is never touched. Deleting a missing one is fine.
 */
export async function deleteSheetMarker(urls: ProviderUrls, sa: ServiceAccount, spreadsheetId: string, key: SheetWriteKey) {
  const requests = [{ deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId: key.id, metadataKey: MARKER_KEY, metadataValue: key.value } } } }];
  await sheets(urls, sa, `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, { method: "POST", headers: json, body: JSON.stringify({ requests }) }, false);
}

// ---------------------------------------------------------------- Slack

const SLACK_AUTH = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);
const SLACK_HINTS: Record<string, string> = {
  not_in_channel: "The Slack app is not in that channel. Type /invite and the app's name in the channel, then retry.",
  channel_not_found: "Slack could not find the channel. Pick the channel again in Apps.",
  is_archived: "The Slack channel is archived. Pick another channel in Apps.",
  restricted_action: "Slack workspace settings stop the app from posting in that channel. Ask a Slack admin.",
};

/** Slack's Web API answers HTTP 200 with ok: false and an error code, except for rate limits (HTTP 429). */
async function slackCall(urls: ProviderUrls, token: string, method: string, params: Record<string, string>, write = false) {
  const res = await call(`${urls.slack}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: new URLSearchParams(params) }, urls.timeoutMs ?? 10_000, write, "Slack");
  if (res.status === 429) throw new ProviderError("Slack is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers));
  if (res.status >= 500) throw new ProviderError(`Slack answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  if (res.body.ok === true) return res.body;
  const error = String(res.body.error ?? `HTTP ${res.status}`);
  if (SLACK_AUTH.has(error)) throw new ProviderError("Slack no longer accepts the app's token. Connect Slack again.", "auth");
  if (error === "ratelimited") throw new ProviderError("Slack is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers));
  if (error === "missing_scope") throw new ProviderError(`The Slack app needs the ${String(res.body.needed ?? "")} scope. Add it in the app's settings, reinstall it, and connect again.`, "permission");
  if (SLACK_HINTS[error]) throw new ProviderError(SLACK_HINTS[error], "permission");
  throw new ProviderError(`Slack said ${error}.`, "invalid");
}

/** auth.test: proves the token works and names the workspace. */
export async function slackIdentity(urls: ProviderUrls, token: string) {
  const body = await slackCall(urls, token, "auth.test", {});
  return { team: String(body.team ?? "Slack") };
}

/** Public channels, for the channel picker (channels:read). ponytail: first 200 only; page with next_cursor if a workspace has more. */
export async function slackChannels(urls: ProviderUrls, token: string) {
  const body = await slackCall(urls, token, "conversations.list", { types: "public_channel", exclude_archived: "true", limit: "200" });
  return ((body.channels as { id: string; name: string; is_member?: boolean }[] | undefined) ?? []).map((c) => ({ id: c.id, name: c.name, isMember: c.is_member === true }));
}

/** chat.postMessage (chat:write). The channel and ts returned identify the message. */
export async function slackPost(urls: ProviderUrls, token: string, channel: string, text: string) {
  const body = await slackCall(urls, token, "chat.postMessage", { channel, text, unfurl_links: "false" }, true);
  return { channel: String(body.channel), ts: String(body.ts) };
}

// ---------------------------------------------------------------- Telegram

/** Telegram's Bot API answers { ok, result } with an HTTP status that matches (401, 403, 400, 429). The token sits in the URL path, so no error here may echo the URL. */
async function telegramCall(urls: ProviderUrls, token: string, method: string, params: Record<string, string>, write = false) {
  const res = await call(`${urls.telegram}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) }, urls.timeoutMs ?? 10_000, write, "Telegram");
  if (res.status === 429) {
    const s = Number((res.body.parameters as { retry_after?: unknown } | undefined)?.retry_after);
    throw new ProviderError("Telegram is limiting requests right now. Daloy will try again.", "quota", Number.isFinite(s) && s > 0 ? s * 1000 : retryAfter(res.headers));
  }
  if (res.status >= 500) throw new ProviderError(`Telegram answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  if (res.body.ok === true) return res.body.result as Record<string, unknown>;
  const text = String(res.body.description ?? "").toLowerCase();
  if (res.status === 401 || res.status === 404) throw new ProviderError("Telegram no longer accepts the bot token. Connect Telegram again.", "auth");
  if (res.status === 403) throw new ProviderError("The bot cannot message that chat. Open the chat, add the bot, press Start if it is a private chat, then retry.", "permission");
  if (text.includes("chat not found")) throw new ProviderError("Telegram could not find that chat. Send the bot a message first, then check the chat id.", "permission");
  throw new ProviderError("Telegram refused the message.", "invalid");
}

/** getMe: proves the token works and names the bot. */
export async function telegramIdentity(urls: ProviderUrls, token: string) {
  const bot = await telegramCall(urls, token, "getMe", {});
  return { bot: `@${String(bot.username ?? "bot")}` };
}

/** getChat: proves the bot can see the chat and gives it a name for the Apps page. */
export async function telegramChat(urls: ProviderUrls, token: string, chatId: string) {
  const chat = await telegramCall(urls, token, "getChat", { chat_id: chatId });
  return { chatId: String(chat.id ?? chatId), chatTitle: String(chat.title ?? chat.username ?? chat.first_name ?? chatId) };
}

/** sendMessage as plain text (no parse_mode, so run data cannot break formatting). */
export async function telegramSend(urls: ProviderUrls, token: string, chatId: string, text: string) {
  const msg = await telegramCall(urls, token, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: "true" }, true);
  return { chatId, messageId: String(msg.message_id) };
}

// ---------------------------------------------------------------- Microsoft: Outlook through Graph, and Teams Workflows

/** Delegated permissions for Outlook: send as the signed-in mailbox, keep access without a sign-in each time, read the address. */
export const OUTLOOK_SCOPES = "offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read";

function microsoftApp(urls: ProviderUrls) {
  if (!urls.microsoft || !urls.microsoftLogin) throw new ProviderError("Outlook is not set up on this installation. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.", "invalid");
  return { ...urls.microsoft, base: `${urls.microsoftLogin}/${encodeURIComponent(urls.microsoft.tenant)}` };
}

/** The Microsoft sign-in and consent page, with PKCE (S256). */
export function outlookAuthorizeUrl(urls: ProviderUrls, o: { redirectUri: string; state: string; codeChallenge: string }) {
  const app = microsoftApp(urls);
  const q = new URLSearchParams({
    client_id: app.clientId,
    response_type: "code",
    redirect_uri: o.redirectUri,
    response_mode: "query",
    scope: OUTLOOK_SCOPES,
    state: o.state,
    code_challenge: o.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${app.base}/oauth2/v2.0/authorize?${q}`;
}

/** The page an administrator opens to approve Daloy for the whole organization. */
export function outlookAdminConsentUrl(urls: ProviderUrls, redirectUri: string) {
  const app = microsoftApp(urls);
  const q = new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, scope: "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read" });
  return `${app.base}/v2.0/adminconsent?${q}`;
}

/**
 * What a consent error on the way back means. Microsoft answers access_denied both when the person said no and when
 * tenant policy blocks user consent, so the AADSTS code in the description decides.
 */
export function consentOutcome(error: string, description = ""): "admin_required" | "declined" | "failed" {
  if (/AADSTS(90094|90095|900941|65002)/.test(description) || /admin/i.test(description)) return "admin_required";
  if (error === "access_denied" || error === "consent_required" || /AADSTS65004/.test(description)) return "declined";
  return "failed";
}

type MsTokens = { accessToken: string; refreshToken: string; expiresIn: number };

/** The token endpoint, for the authorization code and for refresh. invalid_grant and friends mean the owner must reconnect. */
async function microsoftToken(urls: ProviderUrls, params: Record<string, string>): Promise<MsTokens> {
  const app = microsoftApp(urls);
  const body = new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, scope: OUTLOOK_SCOPES, ...params });
  const res = await call(`${app.base}/oauth2/v2.0/token`, { method: "POST", body }, urls.timeoutMs ?? 10_000, false, "Microsoft sign-in");
  if (res.status === 200 && typeof res.body.access_token === "string" && typeof res.body.refresh_token === "string") {
    return { accessToken: res.body.access_token, refreshToken: res.body.refresh_token, expiresIn: typeof res.body.expires_in === "number" ? res.body.expires_in : 3600 };
  }
  const error = String(res.body.error ?? "");
  const description = String(res.body.error_description ?? "");
  if (res.status === 429) throw new ProviderError("Microsoft sign-in is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers));
  if (res.status >= 500) throw new ProviderError(`Microsoft sign-in answered ${res.status}. Daloy will try again.`, "unavailable");
  if (error === "invalid_client") throw new ProviderError("Microsoft rejected this installation's app settings (MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET).", "invalid");
  if (consentOutcome(error, description) === "admin_required") {
    throw new ProviderError("Your organization now requires an administrator to approve Daloy. Ask them to approve it, then reconnect Outlook.", "auth");
  }
  // invalid_grant (expired or revoked), interaction_required (password changed, policy), consent withdrawn.
  throw new ProviderError("Microsoft no longer accepts Daloy's access to this mailbox. It may have been revoked or expired. Reconnect Outlook.", "auth");
}

export const outlookCodeTokens = (urls: ProviderUrls, code: string, codeVerifier: string, redirectUri: string) =>
  microsoftToken(urls, { grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri });

// Access tokens by refresh token hash, in memory, so a burst of deliveries signs in once. shortcut: per process.
const msTokenCache = new Map<string, { token: string; expiresAt: number }>();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function graphFailure(res: Reply, write: boolean): ProviderError {
  const err = (res.body.error ?? {}) as { code?: unknown; message?: unknown };
  const code = String(err.code ?? "");
  const said = err.message ? ` Microsoft said: ${String(err.message)}` : "";
  if (res.status === 401) return new ProviderError("Microsoft did not accept Daloy's access. Reconnect Outlook.", "auth");
  if (res.status === 403 || code === "MailboxNotEnabledForRESTAPI" || code === "ErrorSendAsDenied") {
    return new ProviderError(`The mailbox refused to send (${code || res.status}). It may have no Exchange Online licence, or a policy blocks sending.${said}`, "permission");
  }
  if (res.status === 429 || code === "ErrorQuotaExceeded") return new ProviderError("Outlook is limiting how much this mailbox sends right now. Daloy will try again.", "quota", retryAfter(res.headers));
  if (res.status >= 500) return new ProviderError(`Outlook answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  return new ProviderError(`Outlook rejected the message${said || ` (${res.status})`}.`, "invalid");
}

/**
 * A Graph call as the connected mailbox. Signs in with the stored refresh token, saves the new one Microsoft hands
 * back (saveRefreshToken), and after a 401 (an access token that expired early) signs in once more.
 */
async function graph(urls: ProviderUrls, refreshToken: string, saveRefreshToken: (t: string) => Promise<void>, path: string, init: RequestInit, write: boolean): Promise<Reply> {
  let current = refreshToken;
  for (let tries = 0; ; tries++) {
    let cached = msTokenCache.get(hash(current));
    if (!cached || cached.expiresAt < Date.now() + 60_000) {
      const t = await microsoftToken(urls, { grant_type: "refresh_token", refresh_token: current });
      cached = { token: t.accessToken, expiresAt: Date.now() + t.expiresIn * 1000 };
      if (t.refreshToken !== current) {
        await saveRefreshToken(t.refreshToken);
        current = t.refreshToken;
      }
      msTokenCache.set(hash(current), cached);
    }
    const res = await call(`${urls.graph}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${cached.token}` } }, urls.timeoutMs ?? 10_000, write, "Outlook");
    if (res.status === 200 || res.status === 202) return res;
    if (res.status === 401 && tries === 0) {
      msTokenCache.delete(hash(current));
      continue;
    }
    throw graphFailure(res, write);
  }
}

/** The mailbox the owner consented with: its address is what the connection shows and where the test email goes. */
export async function outlookMailbox(urls: ProviderUrls, accessToken: string) {
  const res = await call(`${urls.graph}/v1.0/me?$select=mail,userPrincipalName,displayName`, { headers: { authorization: `Bearer ${accessToken}` } }, urls.timeoutMs ?? 10_000, false, "Outlook");
  if (res.status !== 200) throw graphFailure(res, false);
  return String(res.body.mail || res.body.userPrincipalName || "");
}

export type OutlookMessage = { to: string; subject: string; text: string };

/** sendMail answers 202 with no body and no message id, so there is nothing to look up afterwards. A copy goes to Sent Items. */
export async function outlookSend(urls: ProviderUrls, refreshToken: string, saveRefreshToken: (t: string) => Promise<void>, m: OutlookMessage) {
  const message = { subject: m.subject, body: { contentType: "Text", content: m.text }, toRecipients: m.to.split(",").map((a) => ({ emailAddress: { address: a.trim() } })) };
  await graph(urls, refreshToken, saveRefreshToken, "/v1.0/me/sendMail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, saveToSentItems: true }) }, true);
  return { to: m.to, sent: true };
}

/**
 * A Teams Workflows webhook URL, checked before it is stored or called: https on a Microsoft host (127.0.0.1 is allowed
 * over http only when a test lists it). The URL itself is the credential, so it is stored encrypted and never shown.
 */
export function teamsWebhookUrl(urls: ProviderUrls, input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const allowed = (urls.teamsHosts ?? []).some((h) => host === h || host.endsWith(`.${h}`));
  const scheme = u.protocol === "https:" || (u.protocol === "http:" && host === "127.0.0.1");
  return allowed && scheme && !u.username && !u.password ? u.toString() : null;
}

/**
 * Posts an Adaptive Card with the text. Workflows answers 202 when it accepts the request and posts to the channel
 * afterwards, so "accepted" is all Daloy can know; a failure inside the flow shows in the flow's run history in Teams.
 */
export async function teamsPost(urls: ProviderUrls, webhookUrl: string, text: string) {
  const url = teamsWebhookUrl(urls, webhookUrl);
  if (!url) throw new ProviderError("The Teams workflow link is not a Microsoft Workflows address. Paste the link again.", "auth");
  const card = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body: text.split("\n").map((line) => ({ type: "TextBlock", text: line, wrap: true })) },
      },
    ],
  };
  const res = await call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(card) }, urls.timeoutMs ?? 10_000, true, "Teams");
  if (res.status === 200 || res.status === 202) return { accepted: true };
  if (res.status === 404) throw new ProviderError("The Teams workflow was deleted or turned off. Create it again in Teams and paste the new link.", "auth");
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError("The Teams workflow only accepts signed-in callers. In the workflow's trigger, set Who can trigger the flow to Anyone, or ask your Teams administrator.", "permission");
  }
  if (res.status === 429) throw new ProviderError("Teams is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers));
  if (res.status >= 500) throw new ProviderError(`Teams answered ${res.status}.`, "ambiguous");
  throw new ProviderError(`Teams rejected the card (${res.status}). Check that the workflow posts the card it receives.`, "invalid");
}
