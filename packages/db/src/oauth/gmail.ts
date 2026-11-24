import { and, eq, isNotNull, sql } from "drizzle-orm";
import { call, ProviderError, retryAfter, type ProviderUrls, type Reply } from "../providers";
import { mailSenders } from "../schema";
import type { GrantStore, OAuthProvider } from "./core";
import { googleIdentity, googleProvider } from "./google";

/**
 * Gmail through Connect with Google (decision 0063): gmail.send on the shared OAuth core, sending with the Gmail API.
 * The grant lives on the owner's mail_senders row, not in connections, so decision 0020's rules stay in one place:
 * one sender per workspace, and a failed or disconnected sender blocks the send with no fallback to another sender.
 */

/**
 * Associated data of the OAuth token blob, which reuses mail_senders.password_* (one set of encrypted columns). The
 * app password uses "gmail_app_password", so a blob never decrypts as a password or the other way round.
 */
export const GMAIL_GRANT = "gmail_oauth";

const own = (userId: string) => eq(mailSenders.userId, userId);

/** The Gmail grant on mail_senders. The refresh lock is SELECT ... FOR UPDATE on the owner's mail_senders row. */
export const gmailStore: GrantStore = {
  secretName: GMAIL_GRANT,
  lock: async (tx, userId) => {
    const [r] = await tx.select().from(mailSenders).where(and(own(userId), eq(mailSenders.authMethod, "oauth"))).for("update");
    return r?.passwordCiphertext && r.passwordIv && r.passwordAuthTag ? { ciphertext: r.passwordCiphertext, iv: r.passwordIv, authTag: r.passwordAuthTag } : null;
  },
  refreshed: async (tx, userId, e, accessExpiresAt) => {
    await tx.update(mailSenders).set({ passwordCiphertext: e.ciphertext, passwordIv: e.iv, passwordAuthTag: e.authTag, accessExpiresAt, refreshedAt: new Date(), updatedAt: new Date() }).where(own(userId));
  },
  // Same effect as Gmail refusing an app password (markSenderFailed): sends stay blocked until the owner reconnects.
  refused: async (tx, userId, revision, error) => {
    await tx.update(mailSenders).set({ status: "failed", lastError: error.slice(0, 500), updatedAt: new Date() }).where(and(own(userId), eq(mailSenders.passwordIv, revision)));
  },
  connect: async (tx, userId, e, blob, who) => {
    // Locks the row, so a refresh in flight finishes first and cannot write its old grant over this one.
    await tx.select({ userId: mailSenders.userId }).from(mailSenders).where(own(userId)).for("update");
    const values = {
      // Google confirmed this address (googleIdentity's emailVerified), which is what the test email's link proves for an
      // app password (decision 0020). Another Google account replaces the address, as a new address does today.
      address: who.account.trim().toLowerCase(),
      status: "active" as const,
      passwordCiphertext: e.ciphertext,
      passwordIv: e.iv,
      passwordAuthTag: e.authTag,
      verifiedAt: new Date(),
      verifyTokenHash: null,
      verifyExpiresAt: null,
      lastError: null,
      updatedAt: new Date(),
      authMethod: "oauth" as const,
      externalId: who.externalId,
      scopes: blob.scope,
      accessExpiresAt: blob.accessExpiresAt === null ? null : new Date(blob.accessExpiresAt),
      refreshedAt: new Date(),
    };
    await tx.insert(mailSenders).values({ userId, ...values }).onConflictDoUpdate({ target: mailSenders.userId, set: values });
  },
  due: async (db, days, limit) => {
    const rows = await db
      .select({ userId: mailSenders.userId, ciphertext: mailSenders.passwordCiphertext, iv: mailSenders.passwordIv, authTag: mailSenders.passwordAuthTag })
      .from(mailSenders)
      .where(and(eq(mailSenders.authMethod, "oauth"), eq(mailSenders.status, "active"), isNotNull(mailSenders.passwordCiphertext), sql`coalesce(${mailSenders.refreshedAt}, ${mailSenders.updatedAt}) < now() - make_interval(days => ${days})`))
      .orderBy(sql`coalesce(${mailSenders.refreshedAt}, ${mailSenders.updatedAt})`)
      .limit(limit);
    return rows.map((r) => ({ userId: r.userId, ciphertext: r.ciphertext!, iv: r.iv!, authTag: r.authTag! }));
  },
  // Disconnect keeps the row as "disconnected" with no credential, so mail stays blocked (decision 0020), for an app
  // password as for a Google sign-in. Only a Google sign-in has a grant to revoke.
  remove: (db, userId) =>
    db.transaction(async (tx) => {
      const [r] = await tx.select().from(mailSenders).where(own(userId)).for("update");
      if (!r) return { removed: false, credential: null };
      await tx
        .update(mailSenders)
        .set({ status: "disconnected", passwordCiphertext: null, passwordIv: null, passwordAuthTag: null, verifyTokenHash: null, verifyExpiresAt: null, accessExpiresAt: null, updatedAt: new Date() })
        .where(own(userId));
      const oauth = r.authMethod === "oauth" && r.passwordCiphertext && r.passwordIv && r.passwordAuthTag;
      return { removed: true, credential: oauth ? { ciphertext: r.passwordCiphertext!, iv: r.passwordIv!, authTag: r.passwordAuthTag! } : null };
    }),
};

/** Gmail on the core: gmail.send plus openid email, and only an address Google says it verified. */
export const gmail: OAuthProvider = {
  ...googleProvider("gmail", "gmail", "gmail", "Gmail"),
  identity: async (urls, accessToken) => {
    const who = await googleIdentity(urls, accessToken);
    if (!who.emailVerified || !who.account.includes("@")) throw new ProviderError("Google did not confirm this account's email address, so kymavo cannot send from it.", "invalid");
    return { externalId: who.externalId, account: who.account };
  },
  store: gmailStore,
};

const QUOTA_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded"]);
const MAX_GMAIL_TEXT = 50_000;

function gmailFailure(res: Reply, write: boolean): never {
  if (res.status === 401) throw new ProviderError("Gmail did not accept kymavo's access.", "auth");
  const error = (res.body.error ?? {}) as { errors?: { reason?: string }[] };
  const reason = error.errors?.[0]?.reason ?? "";
  if (res.status === 429 || (res.status === 403 && QUOTA_REASONS.has(reason))) {
    throw new ProviderError(
      write ? "Gmail is limiting how much this account can send right now. kymavo will try again later." : "Gmail is limiting requests right now. kymavo will try again later.",
      "quota",
      retryAfter(res.headers),
    );
  }
  if (res.status >= 500) {
    throw new ProviderError(
      write ? `Gmail answered ${res.status}, so kymavo cannot tell whether the email went out.` : `Gmail answered ${res.status}.`,
      write ? "ambiguous" : "unavailable",
    );
  }
  if (res.status === 403) {
    throw new ProviderError(
      write ? "Gmail refused to send from this account. Reconnect Gmail in Apps and allow kymavo to send email." : "Gmail refused to read mail from this account. Reconnect Gmail in Apps with read access.",
      "permission",
    );
  }
  throw new ProviderError(write ? `Gmail refused this email (${res.status}).` : `Gmail rejected the request (${res.status}).`, "invalid");
}

async function gmailCall(urls: ProviderUrls, accessToken: string, path: string, init: RequestInit, write: boolean) {
  if (!urls.gmail) throw new ProviderError("Gmail is not set up on this installation.", "invalid");
  const res = await call(`${urls.gmail}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${accessToken}` } }, urls.timeoutMs ?? 30_000, write, "Gmail");
  if (res.status === 200) return res.body;
  throw gmailFailure(res, write);
}

/**
 * users.messages.send with the RFC 822 message nodemailer built (rawMessage in mail.ts), base64url encoded. Errors carry
 * kymavo's own text only: auth (refresh once, then the sender is failed), quota with Retry-After, ambiguous for a 5xx or
 * a timeout once the request may have reached Google (never resent on its own), and permission or invalid otherwise.
 */
export async function gmailSend(urls: ProviderUrls, accessToken: string, raw: Buffer): Promise<{ id: string }> {
  const body = await gmailCall(urls, accessToken, "/gmail/v1/users/me/messages/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: raw.toString("base64url") }) }, true);
  return { id: typeof body.id === "string" ? body.id : "" };
}

export type GmailLabel = { id: string; name: string };
export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  from: string;
  replyTo: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  receivedAt: string;
};

type MimePart = {
  mimeType?: string;
  body?: { data?: string };
  headers?: { name?: string; value?: string }[];
  parts?: MimePart[];
};

const stripHtml = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function decodePart(data: string | undefined): string {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

function extractBody(part: MimePart | undefined): { plain?: string; html?: string } {
  if (!part) return {};
  const mime = (part.mimeType ?? "").toLowerCase();
  if (mime === "text/plain" && part.body?.data) return { plain: decodePart(part.body.data) };
  if (mime === "text/html" && part.body?.data) return { html: decodePart(part.body.data) };
  let plain: string | undefined;
  let html: string | undefined;
  for (const child of part.parts ?? []) {
    const found = extractBody(child);
    if (!plain && found.plain) plain = found.plain;
    if (!html && found.html) html = found.html;
    if (plain) break;
  }
  if (!plain && !html && part.body?.data) plain = decodePart(part.body.data);
  return { plain, html };
}

function headerValue(headers: { name?: string; value?: string }[] | undefined, target: string): string {
  const lower = target.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === lower)?.value?.trim() ?? "";
}

/** Lists the mailbox's labels (id and display name), for resolving custom label names. */
export async function gmailLabels(urls: ProviderUrls, accessToken: string): Promise<GmailLabel[]> {
  const body = await gmailCall(urls, accessToken, "/gmail/v1/users/me/labels", {}, false);
  return ((body.labels as { id?: unknown; name?: unknown }[] | undefined) ?? [])
    .filter((l) => typeof l.id === "string" && typeof l.name === "string")
    .map((l) => ({ id: l.id as string, name: l.name as string }));
}

/** Lists message ids matching the query/labels, newest first as returned by Gmail. */
export async function gmailMessagesList(urls: ProviderUrls, accessToken: string, opts: { q?: string; labelIds?: string[]; maxResults?: number }) {
  const params = new URLSearchParams({ maxResults: String(opts.maxResults ?? 20) });
  if (opts.q) params.set("q", opts.q);
  for (const l of opts.labelIds ?? []) params.append("labelIds", l);
  const body = await gmailCall(urls, accessToken, `/gmail/v1/users/me/messages?${params}`, {}, false);
  const messages = ((body.messages as { id?: unknown; threadId?: unknown }[] | undefined) ?? [])
    .filter((m) => typeof m.id === "string")
    .map((m) => ({ id: m.id as string, threadId: typeof m.threadId === "string" ? m.threadId : "" }));
  return { messages, more: typeof body.nextPageToken === "string" && body.nextPageToken.length > 0 };
}

/** Reads one Gmail message in full format and extracts headers, plain text body, labels and timestamp. */
export async function gmailMessageGet(urls: ProviderUrls, accessToken: string, id: string): Promise<GmailMessage> {
  const body = await gmailCall(urls, accessToken, `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, {}, false);
  const payload = body.payload as MimePart | undefined;
  const headers = payload?.headers;
  const from = headerValue(headers, "from");
  const replyTo = headerValue(headers, "reply-to") || from;
  const toRaw = headerValue(headers, "to");
  const to = toRaw ? toRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const subject = headerValue(headers, "subject");
  const messageId = headerValue(headers, "message-id") || null;
  const inReplyTo = headerValue(headers, "in-reply-to") || null;
  const refsRaw = headerValue(headers, "references");
  const references = refsRaw ? refsRaw.split(/\s+/).filter(Boolean) : [];
  const extracted = extractBody(payload);
  const snippet = typeof body.snippet === "string" ? body.snippet : "";
  const rawText = extracted.plain ?? (extracted.html ? stripHtml(extracted.html) : snippet);
  const internalMs = Number(body.internalDate);
  const receivedAt = Number.isFinite(internalMs) ? new Date(internalMs).toISOString() : new Date().toISOString();
  const labelIds = ((body.labelIds as unknown[] | undefined) ?? []).filter((x): x is string => typeof x === "string");
  return {
    id: typeof body.id === "string" ? body.id : id,
    threadId: typeof body.threadId === "string" ? body.threadId : "",
    labelIds,
    from,
    replyTo,
    to,
    subject,
    text: rawText.slice(0, MAX_GMAIL_TEXT),
    messageId,
    inReplyTo,
    references,
    receivedAt,
  };
}
