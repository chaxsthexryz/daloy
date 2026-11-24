import { and, eq, isNotNull, sql } from "drizzle-orm";
import { call, ProviderError, retryAfter, type ProviderUrls } from "../providers";
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

/**
 * users.messages.send with the RFC 822 message nodemailer built (rawMessage in mail.ts), base64url encoded. Errors carry
 * kymavo's own text only: auth (refresh once, then the sender is failed), quota with Retry-After, ambiguous for a 5xx or
 * a timeout once the request may have reached Google (never resent on its own), and permission or invalid otherwise.
 */
export async function gmailSend(urls: ProviderUrls, accessToken: string, raw: Buffer): Promise<{ id: string }> {
  if (!urls.gmail) throw new ProviderError("Gmail is not set up on this installation.", "invalid");
  const init = { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ raw: raw.toString("base64url") }) };
  const res = await call(`${urls.gmail}/gmail/v1/users/me/messages/send`, init, urls.timeoutMs ?? 30_000, true, "Gmail");
  if (res.status === 200) return { id: typeof res.body.id === "string" ? res.body.id : "" };
  if (res.status === 401) throw new ProviderError("Gmail did not accept kymavo's access.", "auth");
  const error = (res.body.error ?? {}) as { errors?: { reason?: string }[] };
  const reason = error.errors?.[0]?.reason ?? "";
  if (res.status === 429 || (res.status === 403 && QUOTA_REASONS.has(reason))) {
    throw new ProviderError("Gmail is limiting how much this account can send right now. kymavo will try again later.", "quota", retryAfter(res.headers));
  }
  if (res.status >= 500) throw new ProviderError(`Gmail answered ${res.status}, so kymavo cannot tell whether the email went out.`, "ambiguous");
  if (res.status === 403) throw new ProviderError("Gmail refused to send from this account. Reconnect Gmail in Apps and allow kymavo to send email.", "permission");
  throw new ProviderError(`Gmail refused this email (${res.status}).`, "invalid");
}
