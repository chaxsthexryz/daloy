import { createHash, createSign, randomBytes } from "node:crypto";
import { normalizePhMobile, SMS_MAX_CHARS } from "@daloy/engine";
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
  calendar: string;
  drive: string;
  slack: string;
  telegram: string;
  /** UniSMS API base. Unset in test fakes: unismsSend falls back to https://unismsapi.com. */
  unisms?: string;
  /** PayMongo API base. Unset in test fakes: paymongo.ts falls back to the real one. */
  paymongo?: string;
  airtable: string;
  notion: string;
  trello: string;
  microsoftLogin?: string;
  graph?: string;
  /** Sign-in hosts and the installation's own OAuth clients for Airtable, Notion and Trello (decision 0062). Notion signs in on its API host. Unset client: the paste form stays. */
  airtableLogin?: string;
  trelloLogin?: string;
  airtableClient?: { clientId: string; clientSecret: string };
  notionClient?: { clientId: string; clientSecret: string };
  trelloClient?: { clientId: string; clientSecret: string };
  /** Host suffixes a Teams Workflows URL may use. 127.0.0.1 (tests only) is the one host allowed over http. */
  teamsHosts?: string[];
  /** The installation's own Microsoft Entra app, for Outlook consent. Unset: Outlook is not offered (decision 0023). */
  microsoft?: { clientId: string; clientSecret: string; tenant: string };
  /** The installation's Google OAuth client and endpoints (decision 0060). Unset: Google keeps its service account form. */
  googleOAuth?: GoogleOAuthConfig;
  /** Gmail API base, for Gmail sent through a Google sign-in (decision 0063). Unset: such a sender is blocked. */
  gmail?: string;
  /** The installation's own Slack app, for "Connect Slack" (decision 0061). Unset: the pasted bot token stays the main option. */
  slackClient?: { clientId: string; clientSecret: string };
  timeoutMs?: number;
};
export type GoogleOAuthConfig = { clientId: string; clientSecret: string; authorize: string; token: string; revoke: string; userinfo: string; pickerApiKey?: string; projectNumber?: string };
const trim = (url: string) => url.replace(/\/+$/, "");
export const providerUrls = (env: NodeJS.ProcessEnv = process.env): ProviderUrls => ({
  googleToken: env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
  sheets: trim(env.GOOGLE_SHEETS_URL ?? "https://sheets.googleapis.com"),
  calendar: trim(env.GOOGLE_CALENDAR_URL ?? "https://www.googleapis.com"),
  drive: trim(env.GOOGLE_DRIVE_URL ?? "https://www.googleapis.com"),
  slack: trim(env.SLACK_API_URL ?? "https://slack.com"),
  telegram: trim(env.TELEGRAM_API_URL ?? "https://api.telegram.org"),
  unisms: trim(env.UNISMS_API_URL ?? "https://unismsapi.com"),
  paymongo: trim(env.PAYMONGO_API_URL ?? "https://api.paymongo.com"),
  airtable: trim(env.AIRTABLE_API_URL ?? "https://api.airtable.com"),
  notion: trim(env.NOTION_API_URL ?? "https://api.notion.com"),
  trello: trim(env.TRELLO_API_URL ?? "https://api.trello.com"),
  airtableLogin: trim(env.AIRTABLE_LOGIN_URL ?? "https://airtable.com"),
  trelloLogin: trim(env.TRELLO_LOGIN_URL ?? "https://auth.atlassian.com"),
  airtableClient: env.AIRTABLE_CLIENT_ID && env.AIRTABLE_CLIENT_SECRET ? { clientId: env.AIRTABLE_CLIENT_ID, clientSecret: env.AIRTABLE_CLIENT_SECRET } : undefined,
  notionClient: env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET ? { clientId: env.NOTION_CLIENT_ID, clientSecret: env.NOTION_CLIENT_SECRET } : undefined,
  trelloClient: env.TRELLO_CLIENT_ID && env.TRELLO_CLIENT_SECRET ? { clientId: env.TRELLO_CLIENT_ID, clientSecret: env.TRELLO_CLIENT_SECRET } : undefined,
  microsoftLogin: trim(env.MICROSOFT_LOGIN_URL ?? "https://login.microsoftonline.com"),
  graph: trim(env.MICROSOFT_GRAPH_URL ?? "https://graph.microsoft.com"),
  gmail: trim(env.GMAIL_API_URL ?? "https://gmail.googleapis.com"),
  teamsHosts: (env.TEAMS_WEBHOOK_HOSTS ?? "logic.azure.com,powerplatform.com").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  microsoft:
    env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
      ? { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tenant: env.MICROSOFT_TENANT || "organizations" }
      : undefined,
  googleOAuth:
    env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
      ? {
          clientId: env.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
          authorize: env.GOOGLE_AUTHORIZE_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
          token: env.GOOGLE_OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
          revoke: env.GOOGLE_REVOKE_URL ?? "https://oauth2.googleapis.com/revoke",
          userinfo: env.GOOGLE_USERINFO_URL ?? "https://openidconnect.googleapis.com/v1/userinfo",
          pickerApiKey: env.GOOGLE_PICKER_API_KEY || undefined,
          projectNumber: env.GOOGLE_PROJECT_NUMBER || undefined,
        }
      : undefined,
  slackClient: env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET ? { clientId: env.SLACK_CLIENT_ID, clientSecret: env.SLACK_CLIENT_SECRET } : undefined,
});

export type Reply = { status: number; headers: Headers; body: Record<string, unknown> };

/**
 * One call with a timeout. For a write, a timeout or a dropped connection is ambiguous: the request may have arrived.
 * A refused connection or failed DNS lookup means it did not, so that is only "unavailable".
 */
export async function call(url: string, init: RequestInit, timeoutMs: number, write: boolean, what: string): Promise<Reply> {
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

export const retryAfter = (headers: Headers) => {
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
/**
 * What a Sheets or Drive call signs in with: a service account (JWT grant, cached here) or an OAuth access token that
 * withFreshToken already made fresh (decision 0060). A 401 on an OAuth token is an auth error, so withFreshToken refreshes once.
 */
export type GoogleAuth = ServiceAccount | { accessToken: string };
const isOAuth = (auth: GoogleAuth): auth is { accessToken: string } => "accessToken" in auth;
const bearer = (urls: ProviderUrls, auth: GoogleAuth, scope: string) => (isOAuth(auth) ? Promise.resolve(auth.accessToken) : accessToken(urls, auth, scope));
// Under drive.file Google answers 404 (or 403) for any file the owner did not pick and Daloy did not create, and after a reconnect a picked file may need picking again.
const PICK_SHEET_AGAIN = "Daloy cannot open this spreadsheet with your Google connection. In Apps, pick the sheet again (Google lets Daloy reach only sheets you picked or Daloy created).";
const PICK_FOLDER_AGAIN = "Daloy cannot open this Drive folder with your Google connection. In Apps, pick the folder again (Google lets Daloy reach only folders you picked or Daloy created).";
export type SheetDestination = { spreadsheetId: string; tab: string };

/** Takes a sheet link (https://docs.google.com/spreadsheets/d/<id>/edit) or the id itself. */
export function spreadsheetIdFrom(input: string): string | null {
  const id = /\/spreadsheets\/d\/([\w-]+)/.exec(input)?.[1] ?? input.trim();
  return /^[\w-]{10,100}$/.test(id) ? id : null;
}

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
// The service account key signs for calendar.events. A Google sign-in asks for calendar.app.created instead (oauth/google.ts).
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
// Access tokens by key, in memory. ponytail: per process, so the API and the worker each fetch their own; fine at this scale.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const cacheKey = (sa: ServiceAccount, scope = SHEETS_SCOPE) => createHash("sha256").update(`${scope}\n${sa.client_email}\n${sa.private_key}`).digest("hex");

/** The OAuth JWT bearer grant for service accounts: a signed assertion swapped for a one-hour access token. */
async function accessToken(urls: ProviderUrls, sa: ServiceAccount, scope = SHEETS_SCOPE): Promise<string> {
  const cached = tokenCache.get(cacheKey(sa, scope));
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: sa.client_email, scope, aud: urls.googleToken, iat: now, exp: now + 3600 })}`;
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  } catch {
    throw new ProviderError("The service account key could not be read. Connect Google again with a new key file.", "auth");
  }
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` });
  const res = await call(urls.googleToken, { method: "POST", body }, urls.timeoutMs ?? 10_000, false, "Google sign-in");
  if (res.status === 400 || res.status === 401) {
    throw new ProviderError("Google rejected the service account key. It may have been deleted or disabled. Connect Google Sheets again.", "auth");
  }
  if (res.status !== 200 || typeof res.body.access_token !== "string") throw new ProviderError(`Google sign-in answered ${res.status}. Daloy will try again.`, "unavailable");
  const expiresIn = typeof res.body.expires_in === "number" ? res.body.expires_in : 3600;
  tokenCache.set(cacheKey(sa, scope), { token: res.body.access_token, expiresAt: Date.now() + expiresIn * 1000 });
  return res.body.access_token;
}

function sheetsFailure(res: Reply, auth: GoogleAuth, write: boolean): ProviderError {
  const message = String((res.body.error as { message?: unknown } | undefined)?.message ?? "");
  if (res.status === 401) return new ProviderError("Google did not accept Daloy's access. Connect Google Sheets again.", "auth");
  if (isOAuth(auth) && (res.status === 403 || res.status === 404)) return new ProviderError(PICK_SHEET_AGAIN, "permission");
  const share = isOAuth(auth) ? "" : `Share the sheet with ${auth.client_email} as an Editor.`;
  if (res.status === 403) return new ProviderError(`Google Sheets refused access. ${share}${message ? ` Google said: ${message}` : ""}`, "permission");
  if (res.status === 404) return new ProviderError(`The spreadsheet was not found. Check the link, and ${share.charAt(0).toLowerCase()}${share.slice(1)}`, "permission");
  if (res.status === 429) return new ProviderError("Google Sheets is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers));
  // A server error on a write may still have written the row, so the next attempt looks first.
  if (res.status >= 500) return new ProviderError(`Google Sheets answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  return new ProviderError(`Google Sheets rejected the request${message ? `: ${message}` : ` (${res.status})`}.`, "invalid");
}

/** A Sheets API call. A service account's 401 drops the cached token and tries once more; an OAuth 401 goes back to withFreshToken. */
async function sheets(urls: ProviderUrls, auth: GoogleAuth, path: string, init: RequestInit, write: boolean): Promise<Record<string, unknown>> {
  for (let tries = 0; ; tries++) {
    const token = await bearer(urls, auth, SHEETS_SCOPE);
    const res = await call(`${urls.sheets}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }, urls.timeoutMs ?? 10_000, write, "Google Sheets");
    if (res.status === 200) return res.body;
    if (res.status === 401 && tries === 0 && !isOAuth(auth)) {
      tokenCache.delete(cacheKey(auth, SHEETS_SCOPE));
      continue;
    }
    throw sheetsFailure(res, auth, write);
  }
}

// A tab name in A1 notation is quoted, with quotes doubled, so names with spaces or apostrophes work.
const range = (tab: string, cells: string) => encodeURIComponent(`'${tab.replaceAll("'", "''")}'!${cells}`);

/** The spreadsheet's title and tab names, to check access when connecting. Reads only. */
export async function sheetInfo(urls: ProviderUrls, auth: GoogleAuth, spreadsheetId: string) {
  const body = await sheets(urls, auth, `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`, {}, false);
  const tabs = ((body.sheets as { properties: { title: string } }[] | undefined) ?? []).map((s) => s.properties.title);
  return { title: String((body.properties as { title?: unknown } | undefined)?.title ?? ""), tabs };
}

/**
 * Adds the row under the last one in the tab. RAW keeps every value as typed, so form text such as "=IMPORTXML(...)"
 * is stored as text and never runs as a formula.
 */
export async function appendRow(urls: ProviderUrls, auth: GoogleAuth, dest: SheetDestination, row: string[]) {
  const path = `/v4/spreadsheets/${encodeURIComponent(dest.spreadsheetId)}/values/${range(dest.tab, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const body = await sheets(urls, auth, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: [row] }) }, true);
  return { range: String((body.updates as { updatedRange?: unknown } | undefined)?.updatedRange ?? "") };
}

/** A Sheets write's marker: a developer metadata id and value, chosen when the delivery is queued (decision 0021). */
export type SheetWriteKey = { id: number; value: string };
const MARKER_KEY = "daloy";
const json = { "content-type": "application/json" };

async function sheetIdOf(urls: ProviderUrls, auth: GoogleAuth, dest: SheetDestination): Promise<number> {
  const body = await sheets(urls, auth, `/v4/spreadsheets/${encodeURIComponent(dest.spreadsheetId)}?fields=sheets.properties(sheetId,title)`, {}, false);
  const tab = ((body.sheets as { properties: { sheetId: number; title: string } }[] | undefined) ?? []).find((s) => s.properties.title === dest.tab);
  if (!tab) throw new ProviderError(`The tab "${dest.tab}" is no longer in the spreadsheet. Pick the tab again in Apps, then retry.`, "invalid");
  return tab.properties.sheetId;
}

/** The value of our marker with this id, "" for someone else's metadata under that id, or null when there is none. */
async function markerAt(urls: ProviderUrls, auth: GoogleAuth, spreadsheetId: string, id: number): Promise<string | null> {
  try {
    const body = await sheets(urls, auth, `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/developerMetadata/${id}`, {}, false);
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
export async function appendRowOnce(urls: ProviderUrls, auth: GoogleAuth, dest: SheetDestination, row: string[], key: SheetWriteKey): Promise<{ sheet: string; reconciled?: true }> {
  const sheetId = await sheetIdOf(urls, auth, dest);
  const requests = [
    { createDeveloperMetadata: { developerMetadata: { metadataId: key.id, metadataKey: MARKER_KEY, metadataValue: key.value, location: { sheetId }, visibility: "PROJECT" } } },
    { appendCells: { sheetId, rows: [{ values: row.map((v) => ({ userEnteredValue: { stringValue: v } })) }], fields: "userEnteredValue" } },
  ];
  try {
    await sheets(urls, auth, `/v4/spreadsheets/${encodeURIComponent(dest.spreadsheetId)}:batchUpdate`, { method: "POST", headers: json, body: JSON.stringify({ requests }) }, true);
    return { sheet: dest.tab };
  } catch (err) {
    if (!(err instanceof ProviderError) || err.kind !== "invalid") throw err;
    const found = await markerAt(urls, auth, dest.spreadsheetId, key.id);
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
export async function deleteSheetMarker(urls: ProviderUrls, auth: GoogleAuth, spreadsheetId: string, key: SheetWriteKey) {
  const requests = [{ deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId: key.id, metadataKey: MARKER_KEY, metadataValue: key.value } } } }];
  await sheets(urls, auth, `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, { method: "POST", headers: json, body: JSON.stringify({ requests }) }, false);
}

// ---------------------------------------------------------------- Google Calendar

export type CalendarDestination = { calendarId: string; title: string };

/** A calendar id (an address, or a long id ending in @group.calendar.google.com), as shown in the calendar's settings. */
export function calendarIdFrom(input: string): string | null {
  const id = input.trim();
  return /^[\w.+%-]{3,200}@[\w.-]{3,100}$/.test(id) ? id : null;
}

/**
 * The Calendar event id for a booking. Google accepts an id chosen by the caller (base32hex: a-v and 0-9) and answers 409
 * when it exists, so creating the event twice is impossible whatever retries happen (decision 0044).
 */
export const calendarEventId = (bookingId: string) => `dl${createHash("sha256").update(bookingId).digest("hex").slice(0, 40)}`;

const PICK_CALENDAR_AGAIN = "Daloy cannot open its calendar with your Google connection. It may have been deleted in Google Calendar. In Apps, choose Create a new Daloy calendar.";

function calendarFailure(res: Reply, auth: GoogleAuth, write: boolean): ProviderError {
  const error = (res.body.error ?? {}) as { errors?: { reason?: unknown }[] };
  const share = isOAuth(auth) ? "" : `Share the calendar with ${auth.client_email} and choose "Make changes to events".`;
  if (res.status === 401) return new ProviderError("Google did not accept Daloy's access. Connect Google Calendar again.", "auth");
  if (res.status === 429 || (res.status === 403 && /rateLimitExceeded|quotaExceeded/i.test(String(error.errors?.[0]?.reason ?? "")))) {
    return new ProviderError("Google Calendar is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers));
  }
  // With calendar.app.created Google answers 403 or 404 for a calendar Daloy did not create or that was deleted (decision 0064).
  if (isOAuth(auth) && (res.status === 403 || res.status === 404)) return new ProviderError(PICK_CALENDAR_AGAIN, "permission");
  if (res.status === 403) return new ProviderError(`Google Calendar refused access. ${share}`, "permission");
  if (res.status === 404) return new ProviderError(`The calendar or event was not found. Check the calendar id, and ${share.charAt(0).toLowerCase()}${share.slice(1)}`, "permission");
  if (res.status >= 500) return new ProviderError(`Google Calendar answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  return new ProviderError(`Google Calendar rejected the request (${res.status}).`, "invalid");
}

/**
 * A Calendar API call. A service account's 401 drops the cached token and tries once more; an OAuth 401 goes back to
 * withFreshToken. Statuses in `accept` come back to the caller instead of failing.
 */
async function calendar(urls: ProviderUrls, auth: GoogleAuth, path: string, init: RequestInit, write: boolean, accept: number[] = []): Promise<Reply> {
  for (let tries = 0; ; tries++) {
    const token = await bearer(urls, auth, CALENDAR_SCOPE);
    const res = await call(`${urls.calendar}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }, urls.timeoutMs ?? 10_000, write, "Google Calendar");
    if (res.status === 200 || res.status === 204 || accept.includes(res.status)) return res;
    if (res.status === 401 && tries === 0 && !isOAuth(auth)) {
      tokenCache.delete(cacheKey(auth, CALENDAR_SCOPE));
      continue;
    }
    throw calendarFailure(res, auth, write);
  }
}

/**
 * Creates the calendar Daloy writes to, in the owner's account. Under calendar.app.created Daloy may use it because
 * Daloy created it. Not idempotent: a lost answer may leave an unused calendar (decision 0064).
 */
export async function createCalendar(urls: ProviderUrls, auth: GoogleAuth, title: string) {
  const res = await calendar(urls, auth, "/calendar/v3/calendars", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ summary: title }) }, true);
  const calendarId = String(res.body.id ?? "");
  if (!calendarId) throw new ProviderError("Google Calendar answered without a calendar id.", "unavailable");
  return { calendarId, title: String(res.body.summary ?? title) };
}

const eventsPath = (calendarId: string) => `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

/** The calendar's title, to check access when connecting. Reads only. */
export async function calendarInfo(urls: ProviderUrls, sa: GoogleAuth, calendarId: string) {
  const res = await calendar(urls, sa, `${eventsPath(calendarId)}?maxResults=1&fields=summary`, {}, false);
  return { title: String(res.body.summary ?? calendarId) };
}

/**
 * Proves Daloy can write: creates a one-hour event tomorrow under a one-off id and deletes it again. A calendar shared
 * as "see all event details" passes the read check but fails here.
 */
export async function calendarWriteTest(urls: ProviderUrls, sa: GoogleAuth, calendarId: string) {
  const eventId = `dltest${createHash("sha256").update(String(Math.random()) + Date.now()).digest("hex").slice(0, 20)}`;
  const start = new Date(Date.now() + 24 * 3600_000);
  const body = { id: eventId, summary: "Test event from Daloy", start: { dateTime: start.toISOString() }, end: { dateTime: new Date(start.getTime() + 3600_000).toISOString() } };
  await calendar(urls, sa, eventsPath(calendarId), { method: "POST", headers: json, body: JSON.stringify(body) }, true);
  await calendar(urls, sa, `${eventsPath(calendarId)}/${eventId}`, { method: "DELETE" }, true, [404, 410]);
  return { created: true, deleted: true };
}

export type CalendarBooking = { status: "active" | "cancelled" | "no_show"; start: Date; end: Date; timezone: string };
export type CalendarContent = { title: string; description: string };

/**
 * Makes the calendar match the booking as it is now. Active: insert the event under the booking's own id; a 409 means it
 * exists, so patch it to the current title and times (status "confirmed" also restores one that was deleted by hand).
 * Cancelled: delete it; already gone (404, 410) is fine. Each branch can be repeated at any time with the same result,
 * so a retry after a lost answer is always safe (decision 0044). Times are sent in UTC with the booking's own zone.
 */
export async function syncCalendarEvent(urls: ProviderUrls, sa: GoogleAuth, calendarId: string, bookingId: string, b: CalendarBooking, content: CalendarContent): Promise<{ event: "created" | "updated" | "deleted"; eventId: string }> {
  const eventId = calendarEventId(bookingId);
  const base = eventsPath(calendarId);
  if (b.status === "cancelled") {
    await calendar(urls, sa, `${base}/${eventId}`, { method: "DELETE" }, true, [404, 410]);
    return { event: "deleted", eventId };
  }
  const fields = {
    summary: content.title,
    description: content.description,
    start: { dateTime: b.start.toISOString(), timeZone: b.timezone },
    end: { dateTime: b.end.toISOString(), timeZone: b.timezone },
  };
  const made = await calendar(urls, sa, base, { method: "POST", headers: json, body: JSON.stringify({ id: eventId, ...fields }) }, true, [409]);
  if (made.status !== 409) return { event: "created", eventId };
  await calendar(urls, sa, `${base}/${eventId}`, { method: "PATCH", headers: json, body: JSON.stringify({ ...fields, status: "confirmed" }) }, true);
  return { event: "updated", eventId };
}

// ---------------------------------------------------------------- Google Drive

export type DriveDestination = { folderId: string; title: string };

/** A folder link (https://drive.google.com/drive/folders/<id>, with or without /u/N/ and a query) or the folder id itself. */
export function driveFolderIdFrom(input: string): string | null {
  const text = input.trim();
  const id = /^https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/.exec(text)?.[1] ?? text;
  return /^[\w-]{10,100}$/.test(id) ? id : null;
}

const SHARED_DRIVE = (sa: ServiceAccount) => `Service accounts can only save files in a shared drive. Move the folder into a shared drive and add ${sa.client_email} as Content manager.`;

function driveFailure(res: Reply, auth: GoogleAuth, write: boolean): ProviderError {
  const error = (res.body.error ?? {}) as { message?: unknown; errors?: { reason?: unknown }[] };
  const message = String(error.message ?? "");
  const reason = String(error.errors?.[0]?.reason ?? "");
  if (res.status === 401) return new ProviderError("Google did not accept Daloy's access. Connect Google Drive again.", "auth");
  if (res.status === 403 && reason === "storageQuotaExceeded") {
    return new ProviderError(isOAuth(auth) ? "The Google account's Drive storage is full. Free up space in Drive, then retry." : SHARED_DRIVE(auth), "permission");
  }
  if (res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(reason))) {
    return new ProviderError("Google Drive is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers));
  }
  if (isOAuth(auth) && (res.status === 403 || res.status === 404)) return new ProviderError(PICK_FOLDER_AGAIN, "permission");
  const share = isOAuth(auth) ? "" : `Share the folder with ${auth.client_email} as Content manager.`;
  if (res.status === 403) return new ProviderError(`Google Drive refused access. ${share}${message ? ` Google said: ${message}` : ""}`, "permission");
  if (res.status === 404) return new ProviderError(`The Drive folder was not found. Check the folder link, and ${share.charAt(0).toLowerCase()}${share.slice(1)}`, "permission");
  if (res.status >= 500) return new ProviderError(`Google Drive answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  return new ProviderError(`Google Drive rejected the request${message ? `: ${message}` : ` (${res.status})`}.`, "invalid");
}

/** A Drive API call. A service account's 401 drops the cached token and tries once more; an OAuth 401 goes back to withFreshToken. */
async function drive(urls: ProviderUrls, auth: GoogleAuth, path: string, init: RequestInit, write: boolean): Promise<Reply> {
  for (let tries = 0; ; tries++) {
    const token = await bearer(urls, auth, DRIVE_SCOPE);
    const res = await call(`${urls.drive}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }, urls.timeoutMs ?? 30_000, write, "Google Drive");
    if (res.status === 200) return res;
    if (res.status === 401 && tries === 0 && !isOAuth(auth)) {
      tokenCache.delete(cacheKey(auth, DRIVE_SCOPE));
      continue;
    }
    throw driveFailure(res, auth, write);
  }
}
/** For the OAuth-only calls in google-access.ts (create a sheet or folder). */
export { sheets as sheetsApi, drive as driveApi };

/** Checks the folder when connecting: a folder the account can add files to, inside a shared drive for a service account (OAuth may use My Drive). Reads only. */
export async function driveFolderInfo(urls: ProviderUrls, auth: GoogleAuth, folderId: string) {
  const res = await drive(urls, auth, `/drive/v3/files/${encodeURIComponent(folderId)}?supportsAllDrives=true&fields=${encodeURIComponent("id,name,mimeType,driveId,capabilities/canAddChildren")}`, {}, false);
  const b = res.body as { name?: unknown; mimeType?: unknown; driveId?: unknown; capabilities?: { canAddChildren?: unknown } };
  if (b.mimeType !== "application/vnd.google-apps.folder") throw new ProviderError("That link is not a Drive folder. Open the folder in Drive and copy its link.", "invalid");
  if (!b.driveId && !isOAuth(auth)) throw new ProviderError(SHARED_DRIVE(auth), "permission");
  if (b.capabilities?.canAddChildren !== true) {
    throw new ProviderError(isOAuth(auth) ? "Your Google account cannot add files to that folder. Pick a folder you can edit." : `Daloy cannot add files to that folder. Share it with ${auth.client_email} as Content manager.`, "permission");
  }
  return { title: String(b.name ?? folderId) };
}

/** Saves one file in the folder. Hand-built multipart/related: the JSON metadata, then the bytes. Not repeatable: a lost answer may mean the file is there. */
export async function driveUpload(urls: ProviderUrls, auth: GoogleAuth, folderId: string, file: { name: string; mimeType: string; data: Buffer }): Promise<{ id: string }> {
  const boundary = `daloy${randomBytes(16).toString("hex")}`;
  const meta = JSON.stringify({ name: file.name, parents: [folderId], mimeType: file.mimeType });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${file.mimeType}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await drive(urls, auth, "/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name", { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body }, true);
  const id = res.body.id;
  if (typeof id !== "string" || !id) throw new ProviderError("Google Drive answered without a file id, so Daloy cannot tell whether the file was saved.", "ambiguous");
  return { id };
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

/** auth.test: proves the token works and names the workspace (team) and its stable id (teamId). */
export async function slackIdentity(urls: ProviderUrls, token: string) {
  const body = await slackCall(urls, token, "auth.test", {});
  return { team: String(body.team ?? "Slack"), teamId: String(body.team_id ?? "") };
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

/** getUpdates answers 409 while the bot has a webhook, so Daloy cannot list its chats. */
const TELEGRAM_WEBHOOK_SET = "This bot has a webhook set, so Telegram will not list its chats. Type the chat id instead, or remove the webhook in the Bot API.";

/** Telegram's Bot API answers { ok, result } with an HTTP status that matches (401, 403, 400, 429). The token sits in the URL path, so no error here may echo the URL. */
async function telegramCall(urls: ProviderUrls, token: string, method: string, params: Record<string, string>, write = false) {
  const res = await call(`${urls.telegram}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) }, urls.timeoutMs ?? 10_000, write, "Telegram");
  if (res.status === 429) {
    const s = Number((res.body.parameters as { retry_after?: unknown } | undefined)?.retry_after);
    throw new ProviderError("Telegram is limiting requests right now. Daloy will try again.", "quota", Number.isFinite(s) && s > 0 ? s * 1000 : retryAfter(res.headers));
  }
  if (res.status >= 500) throw new ProviderError(`Telegram answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  if (res.status === 409) throw new ProviderError(TELEGRAM_WEBHOOK_SET, "invalid");
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

/**
 * getUpdates (no offset, so nothing is consumed): the chats the bot saw in roughly the last day, newest first. Only the id, type and
 * a title are kept. Message text is never read and nothing is stored. Unverified against the live Bot API (see docs/how-it-works.md).
 */
export async function telegramChats(urls: ProviderUrls, token: string) {
  type Chat = { id?: number | string; type?: string; title?: string; username?: string; first_name?: string; last_name?: string };
  type Update = Record<string, { chat?: Chat } | number | undefined>;
  let updates: Update[];
  try {
    updates = (await telegramCall(urls, token, "getUpdates", {})) as unknown as Update[];
  } catch (err) {
    if (err instanceof ProviderError && err.message === TELEGRAM_WEBHOOK_SET) return { chats: [], webhookSet: true };
    throw err;
  }
  const seen = new Map<string, { id: string; type: string; title: string }>();
  for (const u of [...(Array.isArray(updates) ? updates : [])].reverse()) {
    const chat = (["message", "channel_post", "my_chat_member", "edited_message"] as const).map((k) => (u[k] as { chat?: Chat } | undefined)?.chat).find((c) => c?.id !== undefined);
    if (!chat || seen.has(String(chat.id))) continue;
    const title = chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || String(chat.id));
    seen.set(String(chat.id), { id: String(chat.id), type: String(chat.type ?? "unknown"), title: title.slice(0, 100) });
  }
  return { chats: [...seen.values()].slice(0, 20), webhookSet: false };
}

/** sendMessage as plain text (no parse_mode, so run data cannot break formatting). */
export async function telegramSend(urls: ProviderUrls, token: string, chatId: string, text: string) {
  const msg = await telegramCall(urls, token, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: "true" }, true);
  return { chatId, messageId: String(msg.message_id) };
}

// ---------------------------------------------------------------- Airtable, Notion, Trello (decision 0046)

/**
 * One mapping of an HTTP answer to a ProviderError for the three record providers. None of them has a documented
 * idempotency key, so a 5xx or timeout on an add is "ambiguous" (a person decides), never retried on its own. Errors
 * never include the request URL (Trello's key and token are in it) or the answer's text.
 */
function recordFailure(res: Reply, what: string, write: boolean, defaultWaitMs: number): never {
  if (res.status === 429) throw new ProviderError(`${what} is limiting requests right now. Daloy will try again.`, "quota", retryAfter(res.headers) ?? defaultWaitMs);
  if (res.status >= 500) throw new ProviderError(`${what} answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  if (res.status === 401) throw new ProviderError(`${what} no longer accepts the saved token. Connect ${what} again.`, "auth");
  if (res.status === 403 || res.status === 404) throw new ProviderError(`${what} cannot reach that target with this token. Check that it is shared with the token and has write access.`, "permission");
  throw new ProviderError(`${what} refused the request. Check that the field and property names match.`, "invalid");
}

export const enc = encodeURIComponent;

// Airtable: 5 requests a second per base, and a 429 means wait 30 seconds.
export async function airtableCall(urls: ProviderUrls, token: string, method: "GET" | "POST", path: string, body?: object) {
  const res = await call(`${urls.airtable}/v0/${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) }, urls.timeoutMs ?? 10_000, method === "POST", "Airtable");
  if (res.status === 200) return res.body;
  return recordFailure(res, "Airtable", method === "POST", 30_000);
}

/** A one-record read proves the token, base and table (the table may be an id or a name). */
export async function airtableCheck(urls: ProviderUrls, token: string, baseId: string, tableId: string) {
  await airtableCall(urls, token, "GET", `${enc(baseId)}/${enc(tableId)}?maxRecords=1`);
  return { baseId, tableId };
}

/** typecast lets text fill number, date and select fields, so a template needs no per-type care. */
export async function airtableAdd(urls: ProviderUrls, token: string, dest: { baseId: string; tableId: string }, fields: Record<string, string>) {
  const rec = await airtableCall(urls, token, "POST", `${enc(dest.baseId)}/${enc(dest.tableId)}`, { fields, typecast: true });
  return { recordId: String(rec.id) };
}

// Notion: about 3 requests a second, 429 and 529 carry Retry-After. Pinned to an API version whose database object lists its properties.
export const NOTION_VERSION = "2022-06-28";
// write is false for the search POST, a read that a timeout must not turn into "may have been added".
export async function notionCall(urls: ProviderUrls, token: string, method: "GET" | "POST", path: string, body?: object, write = method === "POST") {
  const res = await call(`${urls.notion}/v1/${path}`, { method, headers: { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION, "content-type": "application/json" }, body: body && JSON.stringify(body) }, urls.timeoutMs ?? 10_000, write, "Notion");
  if (res.status === 200) return res.body;
  if (res.status === 529) throw new ProviderError("Notion is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers) ?? 10_000);
  if (res.status === 503 && write && typeof (res.body.additional_data as { committed_resource_id?: unknown } | undefined)?.committed_resource_id === "string") {
    throw new ProviderError(`Notion answered 503 but may have saved the page ${(res.body.additional_data as { committed_resource_id: string }).committed_resource_id}.`, "ambiguous");
  }
  return recordFailure(res, "Notion", write, 10_000);
}

/** The database's name, and the name of its title property (every page needs one, and its name is the owner's). */
export async function notionDatabase(urls: ProviderUrls, token: string, databaseId: string) {
  const db = await notionCall(urls, token, "GET", `databases/${enc(databaseId)}`);
  const props = (db.properties ?? {}) as Record<string, { type?: string }>;
  const titleProperty = Object.keys(props).find((k) => props[k]?.type === "title");
  if (!titleProperty) throw new ProviderError("That Notion object is not a database. Open a database page and copy its link.", "invalid");
  const title = ((db.title ?? []) as { plain_text?: string }[]).map((t) => t.plain_text ?? "").join("") || databaseId;
  return { databaseId, databaseTitle: title, titleProperty };
}

/** Every other field is a text property (rich_text) of that name. */
export async function notionAddPage(urls: ProviderUrls, token: string, dest: { databaseId: string; titleProperty: string }, title: string, fields: Record<string, string>) {
  const text = (content: string) => [{ text: { content } }];
  const properties = { ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { rich_text: text(v) }])), [dest.titleProperty]: { title: text(title) } };
  const page = await notionCall(urls, token, "POST", "pages", { parent: { database_id: dest.databaseId }, properties });
  return { pageId: String(page.id) };
}

// Trello: 100 requests per 10 seconds per token. The key and token travel in the query string, as Trello's REST API expects.
export type TrelloCredential = { key: string; token: string };
/** A pasted key and token travel in the query string; an OAuth 2.0 access token goes in the Authorization header (decision 0062). */
export type TrelloAuth = TrelloCredential | { bearer: string };
export async function trelloCall(urls: ProviderUrls, cred: TrelloAuth, method: "GET" | "POST", path: string, body?: object) {
  const query = "bearer" in cred ? "" : `${path.includes("?") ? "&" : "?"}key=${enc(cred.key)}&token=${enc(cred.token)}`;
  const headers: Record<string, string> = { "content-type": "application/json", ...("bearer" in cred ? { authorization: `Bearer ${cred.bearer}` } : {}) };
  const res = await call(`${urls.trello}/1/${path}${query}`, { method, headers, body: body && JSON.stringify(body) }, urls.timeoutMs ?? 10_000, method === "POST", "Trello");
  if (res.status === 200) return res.body;
  return recordFailure(res, "Trello", method === "POST", 10_000);
}

export async function trelloIdentity(urls: ProviderUrls, cred: TrelloAuth) {
  return { account: `@${String((await trelloCall(urls, cred, "GET", "members/me?fields=username")).username ?? "trello")}` };
}

export async function trelloList(urls: ProviderUrls, cred: TrelloAuth, listId: string) {
  const list = await trelloCall(urls, cred, "GET", `lists/${enc(listId)}?fields=name`);
  return { listId, listName: String(list.name ?? listId) };
}

export async function trelloAddCard(urls: ProviderUrls, cred: TrelloAuth, listId: string, name: string, desc: string) {
  const card = await trelloCall(urls, cred, "POST", "cards", { idList: listId, name, desc });
  return { cardId: String(card.id) };
}

// ---------------------------------------------------------------- Microsoft: Outlook through Graph, and Teams Workflows

/**
 * What a consent error on the way back means. Microsoft answers access_denied both when the person said no and when
 * tenant policy blocks user consent, so the AADSTS code in the description decides.
 */
export function consentOutcome(error: string, description = ""): "admin_required" | "declined" | "failed" {
  if (/AADSTS(90094|90095|900941|65002)/.test(description) || /admin/i.test(description)) return "admin_required";
  if (error === "access_denied" || error === "consent_required" || /AADSTS65004/.test(description)) return "declined";
  return "failed";
}

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

/** The mailbox the owner consented with: its address is what the connection shows, its id the account Daloy pins. */
export async function outlookMailbox(urls: ProviderUrls, accessToken: string) {
  const res = await call(`${urls.graph}/v1.0/me?$select=id,mail,userPrincipalName`, { headers: { authorization: `Bearer ${accessToken}` } }, urls.timeoutMs ?? 10_000, false, "Outlook");
  if (res.status !== 200) throw graphFailure(res, false);
  return { id: String(res.body.id ?? ""), mailbox: String(res.body.mail || res.body.userPrincipalName || "") };
}

export type OutlookMessage = { to: string; subject: string; text: string };

/**
 * sendMail answers 202 with no body and no message id, so there is nothing to look up afterwards. A copy goes to Sent
 * Items. A 401 is an auth refusal: withFreshToken refreshes once and calls this again (decision 0058).
 */
export async function outlookSend(urls: ProviderUrls, accessToken: string, m: OutlookMessage) {
  const message = { subject: m.subject, body: { contentType: "Text", content: m.text }, toRecipients: m.to.split(",").map((a) => ({ emailAddress: { address: a.trim() } })) };
  const res = await call(`${urls.graph}/v1.0/me/sendMail`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ message, saveToSentItems: true }) }, urls.timeoutMs ?? 10_000, true, "Outlook");
  if (res.status !== 202 && res.status !== 200) throw graphFailure(res, true);
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

// ---------------------------------------------------------------- UniSMS (Philippine SMS, phase N7, decision 0068)

export type UnismsMessage = { recipient: string; content: string; senderId?: string; metadata?: Record<string, string> };

function redactUnisms(text: string, secretKey: string): string {
  let out = text;
  if (secretKey) {
    out = out.replaceAll(secretKey, "[secret]");
    const b64 = Buffer.from(`${secretKey}:`).toString("base64");
    if (b64) out = out.replaceAll(b64, "[secret]");
  }
  return out.replace(/\bBasic\s+[A-Za-z0-9+/=]{6,}/gi, "Basic [secret]");
}

/**
 * Sends one Philippine SMS via UniSMS REST API (POST /api/sms with HTTP Basic Auth).
 * - 429 -> quota (honours Retry-After)
 * - 401/403 -> auth (marks workspace connection failed, fenced by credential IV)
 * - 400/4xx -> invalid (never retried)
 * - 5xx / timeout / dropped connection after connect -> ambiguous (parks in needs_review, never blindly double-sent)
 */
export async function unismsSend(urls: ProviderUrls, secretKey: string, sms: UnismsMessage) {
  const phone = normalizePhMobile(sms.recipient);
  if (!phone.ok) throw new ProviderError(phone.error, "invalid");
  const content = sms.content.trim();
  if (!content) throw new ProviderError("SMS message cannot be empty.", "invalid");
  if (content.length > SMS_MAX_CHARS) throw new ProviderError(`SMS message is ${content.length} characters, above the ${SMS_MAX_CHARS}-character limit.`, "invalid");
  const senderId = sms.senderId?.trim() || "Unisoft";
  const base = trim(urls.unisms ?? "https://unismsapi.com");
  const auth = `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
  const body: Record<string, unknown> = { recipient: phone.value, content, sender_id: senderId };
  if (sms.metadata && Object.keys(sms.metadata).length > 0) body.metadata = sms.metadata;
  const res = await call(
    `${base}/api/sms`,
    { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) },
    urls.timeoutMs ?? 10_000,
    true,
    "UniSMS",
  );
  if (res.status === 429) throw new ProviderError("UniSMS is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers));
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError("UniSMS rejected the secret key or account access. Check your UniSMS credentials in Apps.", "auth");
  }
  if (res.status >= 500) throw new ProviderError(`UniSMS answered ${res.status}.`, "ambiguous");
  if (res.status >= 200 && res.status < 300 && res.body.success !== false) {
    return { id: String(res.body.id ?? res.body.message_id ?? res.body.reference_id ?? ""), recipient: phone.value, senderId, sent: true };
  }
  const rawMsg = typeof res.body.message === "string" ? res.body.message : typeof res.body.error === "string" ? res.body.error : "";
  const cleanMsg = redactUnisms(rawMsg, secretKey).slice(0, 200);
  throw new ProviderError(`UniSMS rejected the SMS${cleanMsg ? `: ${cleanMsg}` : ` (${res.status})`}.`, "invalid");
}
