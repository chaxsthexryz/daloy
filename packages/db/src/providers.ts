import { createHash, createSign } from "node:crypto";
import * as z from "zod";

/**
 * Google Sheets and Slack, called with fetch. Every failure becomes a ProviderError whose kind says what the caller
 * should do (decision 0021):
 * - auth: the credential no longer works. Stop using the connection until the owner reconnects.
 * - permission: this destination refused (sheet not shared, app not in the channel). Fix it, then retry.
 * - quota, unavailable: try again later. retryAfterMs is the provider's own hint.
 * - ambiguous: a write timed out or broke after it was sent, so the provider may have done it.
 * - invalid: the request itself was wrong. Retrying the same thing will not help.
 */
export type ProviderErrorKind = "auth" | "permission" | "quota" | "unavailable" | "ambiguous" | "invalid";
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
export type ProviderUrls = { googleToken: string; sheets: string; slack: string; timeoutMs?: number };
export const providerUrls = (env: NodeJS.ProcessEnv = process.env): ProviderUrls => ({
  googleToken: env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
  sheets: (env.GOOGLE_SHEETS_URL ?? "https://sheets.googleapis.com").replace(/\/+$/, ""),
  slack: (env.SLACK_API_URL ?? "https://slack.com").replace(/\/+$/, ""),
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

/** Looks for a row whose first cell is the reference. Used before writing again after an ambiguous result. */
export async function findReference(urls: ProviderUrls, sa: ServiceAccount, dest: SheetDestination, reference: string): Promise<string | null> {
  const body = await sheets(urls, sa, `/v4/spreadsheets/${encodeURIComponent(dest.spreadsheetId)}/values/${range(dest.tab, "A:A")}`, {}, false);
  const rows = (body.values as unknown[][] | undefined) ?? [];
  const i = rows.findIndex((r) => r[0] === reference);
  return i < 0 ? null : `'${dest.tab.replaceAll("'", "''")}'!A${i + 1}`;
}

// ---------------------------------------------------------------- Slack

const SLACK_AUTH = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);
const SLACK_HINTS: Record<string, string> = {
  not_in_channel: "The Slack app is not in that channel. Type /invite and the app's name in the channel, then retry.",
  channel_not_found: "Slack could not find the channel. Pick the channel again in Business and email.",
  is_archived: "The Slack channel is archived. Pick another channel in Business and email.",
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
