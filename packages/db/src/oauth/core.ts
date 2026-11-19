import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto";
import type { Db } from "../index";
import { call, ProviderError, retryAfter, type ProviderUrls } from "../providers";
import { connections, oauthFlows, type Provider } from "../schema";
import { readTokenBlob, type TokenBlob } from "./blob";

export * from "./blob";

/**
 * The shared OAuth core (decision 0058): consent through a one-time flow row, tokens in one encrypted blob per
 * connection, refresh under a row lock, keepalive, and revoke after delete. A provider is data (OAuthProvider), not code.
 */

/** Where the browser lands after consent: /#/apps/<slug>-<outcome>. A closed list, so no provider text reaches the page. */
export const OAUTH_OUTCOMES = ["connected", "declined", "admin_required", "admin_approved", "missing_scope", "expired", "failed"] as const;
export type OAuthOutcome = (typeof OAUTH_OUTCOMES)[number];

/** The one callback every provider returns to, unless its redirectPath says otherwise. */
export const OAUTH_CALLBACK_PATH = "/settings/connections/oauth/callback";
export const FLOW_TTL_MINUTES = 10;

export type OAuthClient = { clientId: string; clientSecret: string };
export type OAuthIdentity = { externalId: string; account: string; destination?: Record<string, string> };

/** Everything that differs between providers. Adding a provider is one of these in oauth/<provider>.ts plus a line in OAUTH_PROVIDERS. */
export type OAuthProvider = {
  provider: Provider;
  /** In URLs (/settings/connections/<slug>/oauth/start) and the landing page address. */
  slug: string;
  /** Shown to people and used in error text. */
  name: string;
  /** The installation's client, from env. Undefined: no Connect button, the paste form stays. */
  client: (urls: ProviderUrls) => OAuthClient | undefined;
  authorizeUrl: (urls: ProviderUrls) => string;
  tokenUrl: (urls: ProviderUrls) => string;
  /** Undefined: the provider has no revoke call Daloy can use, so the page says where to remove access. */
  revokeUrl?: (urls: ProviderUrls) => string;
  /** Notion revokes an access token. Other providers prefer the refresh token when there is one. */
  revokeToken?: "access";
  /** The scope manifest: what is asked for, in order. scopes.test.ts snapshots it. */
  scopes: readonly string[];
  /** What must come back granted, as the provider names it in the token answer. A narrower grant saves nothing. */
  requiredScopes: readonly string[];
  /** Added to the authorize URL. */
  extraParams?: Record<string, string>;
  /** Added to every token request. */
  tokenParams?: Record<string, string>;
  /** Client id and secret as an HTTP Basic header on token and revoke requests, not as body fields (Airtable, Notion). */
  tokenAuth?: "basic";
  /** Token and revoke requests as a JSON body, not a form (Notion, Atlassian for Trello). */
  tokenFormat?: "json";
  /** Added to every token and revoke request. */
  tokenHeaders?: Record<string, string>;
  /** Send a PKCE S256 challenge. */
  pkce: boolean;
  /** The provider hands out refresh tokens: a code exchange without one is refused. */
  refreshTokens: boolean;
  /** The provider still accepts the previous refresh token after it rotated: retry a refused refresh once with it. */
  previousRefreshTokenWorks?: boolean;
  /** The keepalive sweep refreshes a grant this many days after its last refresh, so an idle one does not expire. */
  keepaliveDays: number;
  /** The redirect path registered at the provider. Default OAUTH_CALLBACK_PATH. */
  redirectPath?: string;
  /** The stable account id and a display name, read with a new access token. */
  identity: (urls: ProviderUrls, accessToken: string) => Promise<OAuthIdentity>;
  /** A consent error on the way back, as a closed outcome. Provider text never goes further. */
  outcome: (error: string, description: string) => "declined" | "admin_required" | "failed";
};

/** Scopes Daloy must never ask for: Google restricted scopes need a paid security assessment (plan section 9). */
export const FORBIDDEN_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.insert",
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.metadata",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/drive.activity",
  "https://www.googleapis.com/auth/drive.activity.readonly",
  "https://www.googleapis.com/auth/drive.scripts",
] as const;

export const redirectUri = (publicUrl: string, def: OAuthProvider) => `${publicUrl}${def.redirectPath ?? OAUTH_CALLBACK_PATH}`;

function clientOf(def: OAuthProvider, urls: ProviderUrls): OAuthClient {
  const client = def.client(urls);
  if (!client) throw new ProviderError(`${def.name} is not set up on this installation.`, "invalid");
  return client;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// Associated data for the verifier: the workspace (crypto.ts) and the flow id, so a verifier copied to another flow does not decrypt.
const verifierName = (flowId: string) => `oauth-flow:${flowId}`;

/** The provider's consent page. state is opaque; codeChallenge is the S256 of the verifier when the provider uses PKCE. */
export function authorizeUrl(def: OAuthProvider, urls: ProviderUrls, o: { redirectUri: string; state: string; codeChallenge?: string }) {
  // Notion has no scopes: an empty scope parameter is left out.
  const q = new URLSearchParams({ client_id: clientOf(def, urls).clientId, response_type: "code", redirect_uri: o.redirectUri, ...(def.scopes.length ? { scope: def.scopes.join(" ") } : {}), state: o.state });
  if (def.pkce && o.codeChallenge) {
    q.set("code_challenge", o.codeChallenge);
    q.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(def.extraParams ?? {})) q.set(k, v);
  return `${def.authorizeUrl(urls)}?${q}`;
}

export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/**
 * Start: a flow row with a random state (only its hash stored) and, with PKCE, a random verifier stored encrypted.
 * Bound to the member and workspace, ten minutes. Returns the consent page URL for the browser to open.
 */
export async function startFlow(db: Db, key: Buffer, urls: ProviderUrls, publicUrl: string, def: OAuthProvider, who: { workspaceId: string; memberId: string }) {
  clientOf(def, urls);
  const id = randomUUID();
  const state = randomBytes(32).toString("base64url");
  const verifier = def.pkce ? randomBytes(32).toString("base64url") : undefined;
  const v = verifier ? encryptSecret(key, who.workspaceId, verifierName(id), verifier) : undefined;
  await db.insert(oauthFlows).values({
    id,
    stateHash: sha256(state),
    workspaceId: who.workspaceId,
    memberId: who.memberId,
    provider: def.provider,
    verifierCiphertext: v?.ciphertext,
    verifierIv: v?.iv,
    verifierAuthTag: v?.authTag,
    expiresAt: sql`now() + make_interval(mins => ${FLOW_TTL_MINUTES})`,
  });
  return authorizeUrl(def, urls, { redirectUri: redirectUri(publicUrl, def), state, codeChallenge: verifier && pkceChallenge(verifier) });
}

/**
 * The callback's one-time use of a flow: one guarded UPDATE, so of two callbacks with the same state only one gets the
 * row. Unknown, used, expired, another member's or another workspace's state all give null and change nothing.
 */
export async function consumeFlow(db: Db, key: Buffer, state: string, who: { workspaceId: string; memberId: string }): Promise<{ provider: Provider; verifier?: string } | null> {
  if (!state) return null;
  const [row] = await db
    .update(oauthFlows)
    .set({ consumedAt: sql`now()` })
    .where(and(eq(oauthFlows.stateHash, sha256(state)), isNull(oauthFlows.consumedAt), gt(oauthFlows.expiresAt, sql`now()`), eq(oauthFlows.memberId, who.memberId), eq(oauthFlows.workspaceId, who.workspaceId)))
    .returning();
  if (!row) return null;
  const verifier = row.verifierCiphertext ? decryptSecret(key, row.workspaceId, verifierName(row.id), { ciphertext: row.verifierCiphertext, iv: row.verifierIv!, authTag: row.verifierAuthTag! }) : undefined;
  return { provider: row.provider, verifier };
}

/** Flow rows a day past their expiry. They hold nothing but the encrypted verifier. */
export async function deleteOldFlows(db: Db) {
  const gone = await db.delete(oauthFlows).where(sql`${oauthFlows.expiresAt} < now() - interval '1 day'`).returning({ id: oauthFlows.id });
  return gone.length;
}

// ---------------------------------------------------------------- tokens

/** A token or revoke request: the client's credentials as body fields or a Basic header, and a form or JSON body (decision 0062). */
function clientRequest(def: OAuthProvider, client: OAuthClient, params: Record<string, string>): RequestInit {
  const basic = def.tokenAuth === "basic";
  const all = basic ? params : { client_id: client.clientId, client_secret: client.clientSecret, ...params };
  const headers: Record<string, string> = { ...def.tokenHeaders, ...(basic ? { authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}` } : {}) };
  if (def.tokenFormat === "json") return { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(all) };
  return { method: "POST", headers, body: new URLSearchParams(all) };
}

type TokenAnswer = { accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string };

/** The token endpoint, for a code and for a refresh. Provider text never reaches the error message. */
async function tokenRequest(def: OAuthProvider, urls: ProviderUrls, params: Record<string, string>): Promise<TokenAnswer> {
  const client = clientOf(def, urls);
  const res = await call(def.tokenUrl(urls), clientRequest(def, client, { ...def.tokenParams, ...params }), urls.timeoutMs ?? 10_000, false, `${def.name} sign-in`);
  const b = res.body;
  if (res.status === 200 && typeof b.access_token === "string" && b.access_token && String(b.token_type ?? "").toLowerCase() === "bearer") {
    return {
      accessToken: b.access_token,
      refreshToken: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : undefined,
      expiresIn: typeof b.expires_in === "number" ? b.expires_in : undefined,
      scope: typeof b.scope === "string" ? b.scope : undefined,
    };
  }
  if (res.status === 429) throw new ProviderError(`${def.name} sign-in is limiting requests right now. Daloy will try again.`, "quota", retryAfter(res.headers));
  if (res.status >= 500) throw new ProviderError(`${def.name} sign-in answered ${res.status}. Daloy will try again.`, "unavailable");
  if (res.status === 200) throw new ProviderError(`${def.name} sign-in answered without a bearer access token.`, "invalid");
  const error = String(b.error ?? "");
  if (error === "invalid_client") throw new ProviderError(`${def.name} rejected this installation's app settings (client id or secret).`, "invalid");
  if (def.outcome(error, String(b.error_description ?? "")) === "admin_required") {
    throw new ProviderError(`Your organization now requires an administrator to approve Daloy. Ask them to approve it, then reconnect ${def.name}.`, "auth");
  }
  // invalid_grant (expired, revoked or reused), interaction_required, consent withdrawn.
  throw new ProviderError(`${def.name} no longer accepts Daloy's access. It may have been revoked or expired. Reconnect ${def.name}.`, "auth");
}

/** Granted scopes cover every required one. A provider may name a scope with its resource prefix (Microsoft). No scope field: granted as asked. */
export function grantedEnough(def: OAuthProvider, granted: string | undefined) {
  if (granted === undefined) return true;
  const have = granted.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return def.requiredScopes.every((r) => have.some((g) => g === r.toLowerCase() || g.endsWith(`/${r.toLowerCase()}`)));
}

const expiry = (t: TokenAnswer) => (t.expiresIn === undefined ? null : Date.now() + t.expiresIn * 1000);

/** The code from the callback, exchanged with the verifier. Exported for the Outlook regression tests. */
export const codeTokens = (def: OAuthProvider, urls: ProviderUrls, code: string, verifier: string | undefined, redirect: string) =>
  tokenRequest(def, urls, { grant_type: "authorization_code", code, redirect_uri: redirect, ...(verifier ? { code_verifier: verifier } : {}) });

/**
 * The callback after a consumed flow: exchange, check the grant, read the identity, save. A narrower grant saves
 * nothing ("missing_scope"). A reconnect to the same provider account keeps the destination; another account clears it.
 */
export async function finishFlow(db: Db, key: Buffer, urls: ProviderUrls, publicUrl: string, def: OAuthProvider, workspaceId: string, code: string, verifier: string | undefined): Promise<"connected" | "missing_scope"> {
  const t = await codeTokens(def, urls, code, verifier, redirectUri(publicUrl, def));
  if (!grantedEnough(def, t.scope)) return "missing_scope";
  if (def.refreshTokens && !t.refreshToken) throw new ProviderError(`${def.name} did not give Daloy lasting access.`, "invalid");
  const who = await def.identity(urls, t.accessToken);
  const blob: TokenBlob = { v: 1, accessToken: t.accessToken, accessExpiresAt: expiry(t), refreshToken: t.refreshToken, scope: t.scope ?? def.scopes.join(" ") };
  await db.transaction(async (tx) => {
    // Locks the row, so a refresh in flight finishes first and cannot write its old grant over this one.
    const [old] = await tx.select({ externalId: connections.externalId, destination: connections.destination }).from(connections).where(and(eq(connections.userId, workspaceId), eq(connections.provider, def.provider))).for("update");
    const e = encryptSecret(key, workspaceId, `connection:${def.provider}`, JSON.stringify(blob));
    const values = {
      status: "active" as const,
      account: who.account,
      credentialCiphertext: e.ciphertext,
      credentialIv: e.iv,
      credentialAuthTag: e.authTag,
      destination: who.destination ?? (old && old.externalId === who.externalId ? old.destination : null),
      lastError: null,
      updatedAt: new Date(),
      authMethod: "oauth" as const,
      externalId: who.externalId,
      scopes: blob.scope,
      oauthClientId: clientOf(def, urls).clientId,
      accessExpiresAt: blob.accessExpiresAt === null ? null : new Date(blob.accessExpiresAt),
      refreshedAt: new Date(),
    };
    await tx.insert(connections).values({ userId: workspaceId, provider: def.provider, ...values }).onConflictDoUpdate({ target: [connections.userId, connections.provider], set: values });
  });
  return "connected";
}

// ---------------------------------------------------------------- refresh under a row lock

/** A token with less than this left is refreshed first. */
const SKEW_MS = 2 * 60_000;
const fresh = (b: TokenBlob) => !!b.accessToken && (b.accessExpiresAt === null || b.accessExpiresAt - Date.now() > SKEW_MS);

/** The connection a caller holds. Refresh writes the new credential and revision back into it, so later status writes match. */
export type HeldConnection = { credential: string; revision: string };

const lockTimedOut = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "55P03" || e.cause?.code === "55P03";
};

/**
 * Refreshes under SELECT ... FOR UPDATE, the lock across processes. Under the lock the credential is read again: if
 * another worker refreshed (or the owner reconnected) while this one waited, its token is used and nothing is called.
 * The new pair is written in the same transaction that received it. invalid_grant marks the connection failed for the
 * revision it was read under. 429, 5xx and network trouble leave the row as it was.
 */
async function refreshLocked(db: Db, key: Buffer, urls: ProviderUrls, workspaceId: string, def: OAuthProvider, o: { rejected?: string; force?: boolean }): Promise<HeldConnection> {
  clientOf(def, urls);
  const name = `connection:${def.provider}`;
  let out: { held: HeldConnection } | { refused: ProviderError };
  try {
    out = await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '15s'`);
      const [row] = await tx.select().from(connections).where(and(eq(connections.userId, workspaceId), eq(connections.provider, def.provider))).for("update");
      if (!row) return { refused: new ProviderError(`${def.name} is not connected. Connect it in Apps, then retry.`, "auth") };
      const credential = decryptSecret(key, workspaceId, name, { ciphertext: row.credentialCiphertext, iv: row.credentialIv, authTag: row.credentialAuthTag });
      const blob = readTokenBlob(credential);
      if (!o.force && blob.accessToken !== o.rejected && fresh(blob)) return { held: { credential, revision: row.credentialIv } };
      const refuse = async (err: ProviderError) => {
        await tx.update(connections).set({ status: "failed", lastError: err.message.slice(0, 500), updatedAt: new Date() }).where(and(eq(connections.userId, workspaceId), eq(connections.provider, def.provider), eq(connections.credentialIv, row.credentialIv)));
        return { refused: err };
      };
      if (!blob.refreshToken) return refuse(new ProviderError(`${def.name} no longer accepts Daloy's access. Reconnect ${def.name}.`, "auth"));
      let used = blob.refreshToken;
      let t: TokenAnswer;
      try {
        t = await tokenRequest(def, urls, { grant_type: "refresh_token", refresh_token: used });
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== "auth") throw err;
        if (!def.previousRefreshTokenWorks || !blob.prevRefreshToken) return refuse(err);
        used = blob.prevRefreshToken;
        try {
          t = await tokenRequest(def, urls, { grant_type: "refresh_token", refresh_token: used });
        } catch (again) {
          if (again instanceof ProviderError && again.kind === "auth") return refuse(again);
          throw again;
        }
      }
      if (!grantedEnough(def, t.scope)) return refuse(new ProviderError(`${def.name} no longer grants the permissions Daloy needs. Reconnect ${def.name}.`, "auth"));
      const next: TokenBlob = {
        v: 1,
        accessToken: t.accessToken,
        accessExpiresAt: expiry(t),
        refreshToken: t.refreshToken ?? used,
        prevRefreshToken: t.refreshToken && t.refreshToken !== used ? used : blob.prevRefreshToken,
        scope: t.scope ?? blob.scope,
      };
      const plaintext = JSON.stringify(next);
      const e = encryptSecret(key, workspaceId, name, plaintext);
      await tx
        .update(connections)
        .set({ credentialCiphertext: e.ciphertext, credentialIv: e.iv, credentialAuthTag: e.authTag, accessExpiresAt: next.accessExpiresAt === null ? null : new Date(next.accessExpiresAt), refreshedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(connections.userId, workspaceId), eq(connections.provider, def.provider)));
      return { held: { credential: plaintext, revision: e.iv } };
    });
  } catch (err) {
    if (lockTimedOut(err)) throw new ProviderError(`${def.name} access is being renewed by another task. Daloy will try again.`, "unavailable");
    throw err;
  }
  if ("refused" in out) throw out.refused;
  return out.held;
}

/**
 * A usable access token for the connection: the stored one while it has two minutes left, otherwise one refreshed under
 * the row lock. rejected is a token the API just refused (refresh unless another worker already replaced it); force
 * always refreshes (a console test, the keepalive). Updates conn to the stored credential and revision.
 */
export async function freshToken(db: Db, key: Buffer, urls: ProviderUrls, workspaceId: string, def: OAuthProvider, conn: HeldConnection, o: { rejected?: string; force?: boolean } = {}) {
  const blob = readTokenBlob(conn.credential);
  // A nonexpiring grant with no refresh token can only be checked by calling the API itself.
  if (o.rejected === undefined && fresh(blob) && (!o.force || (!blob.refreshToken && blob.accessExpiresAt === null))) return blob.accessToken;
  const held = await refreshLocked(db, key, urls, workspaceId, def, o);
  conn.credential = held.credential;
  conn.revision = held.revision;
  return readTokenBlob(held.credential).accessToken;
}

/**
 * Calls fn with a fresh access token. An auth refusal from fn (a 401 on a token that should still work) refreshes once
 * and calls fn again; a second refusal is thrown. Callers that hold a transaction call freshToken before opening it.
 */
export async function withFreshToken<T>(db: Db, key: Buffer, urls: ProviderUrls, workspaceId: string, def: OAuthProvider, conn: HeldConnection, fn: (accessToken: string) => Promise<T>, o: { force?: boolean } = {}): Promise<T> {
  const token = await freshToken(db, key, urls, workspaceId, def, conn, o);
  try {
    return await fn(token);
  } catch (err) {
    if (!(err instanceof ProviderError) || err.kind !== "auth") throw err;
    return fn(await freshToken(db, key, urls, workspaceId, def, conn, { rejected: token }));
  }
}

/**
 * The keepalive sweep: refreshes active OAuth connections not refreshed for their provider's keepaliveDays, at most
 * `limit` per call, so an idle workspace keeps its grant. Only invalid_grant marks one failed; anything else waits for
 * the next sweep. Returns how many were refreshed.
 */
export async function keepOAuthAlive(db: Db, key: Buffer, urls: ProviderUrls, defs: readonly OAuthProvider[], limit = 20) {
  let refreshed = 0;
  for (const def of defs) {
    if (!def.client(urls) || refreshed >= limit) continue;
    const due = await db
      .select({ userId: connections.userId, ciphertext: connections.credentialCiphertext, iv: connections.credentialIv, authTag: connections.credentialAuthTag })
      .from(connections)
      .where(and(eq(connections.provider, def.provider), eq(connections.authMethod, "oauth"), eq(connections.status, "active"), sql`coalesce(${connections.refreshedAt}, ${connections.updatedAt}) < now() - make_interval(days => ${def.keepaliveDays})`))
      .orderBy(sql`coalesce(${connections.refreshedAt}, ${connections.updatedAt})`)
      .limit(limit - refreshed);
    for (const r of due) {
      const conn = { credential: decryptSecret(key, r.userId, `connection:${def.provider}`, r), revision: r.iv };
      if (!readTokenBlob(conn.credential).refreshToken) {
        // A token that never expires (Notion may issue one): nothing to refresh. Stamped so the sweep does not pick it up first every day.
        await db.update(connections).set({ refreshedAt: new Date() }).where(and(eq(connections.userId, r.userId), eq(connections.provider, def.provider), eq(connections.credentialIv, r.iv)));
        continue;
      }
      try {
        await freshToken(db, key, urls, r.userId, def, conn, { force: true });
        refreshed++;
      } catch {
        // Marked failed already when the provider refused the grant; otherwise the next sweep tries again.
      }
    }
  }
  return refreshed;
}

/**
 * Disconnect an OAuth connection: delete the row first, so it never looks disconnected in Daloy while still usable,
 * then ask the provider to revoke (5 seconds). revoked is null when the provider has no revoke call, false when it failed.
 */
export async function disconnectOAuth(db: Db, key: Buffer, urls: ProviderUrls, workspaceId: string, def: OAuthProvider): Promise<{ removed: boolean; revoked: boolean | null }> {
  const [row] = await db.delete(connections).where(and(eq(connections.userId, workspaceId), eq(connections.provider, def.provider))).returning();
  if (!row) return { removed: false, revoked: null };
  if (row.authMethod !== "oauth" || !def.revokeUrl) return { removed: true, revoked: null };
  try {
    const client = clientOf(def, urls);
    const blob = readTokenBlob(decryptSecret(key, workspaceId, `connection:${def.provider}`, { ciphertext: row.credentialCiphertext, iv: row.credentialIv, authTag: row.credentialAuthTag }));
    const token = def.revokeToken === "access" ? blob.accessToken : (blob.refreshToken ?? blob.accessToken);
    const init = clientRequest(def, client, { token, ...(def.tokenFormat === "json" ? {} : { token_type_hint: blob.refreshToken ? "refresh_token" : "access_token" }) });
    const res = await call(def.revokeUrl(urls), init, Math.min(5000, urls.timeoutMs ?? 5000), false, `${def.name} revoke`);
    return { removed: true, revoked: res.status >= 200 && res.status < 300 };
  } catch {
    return { removed: true, revoked: false };
  }
}

// ---------------------------------------------------------------- boot check

/** Client env vars of the managed OAuth providers. MICROSOFT_* predates OAUTH_ENV, so it alone does not require it. */
const MANAGED_CLIENT_VARS = ["GOOGLE_OAUTH_CLIENT_ID", "SLACK_CLIENT_ID", "AIRTABLE_CLIENT_ID", "NOTION_CLIENT_ID", "TRELLO_CLIENT_ID"];

/**
 * R13: a development client must not serve a public host, and a production client must not run from a laptop.
 * OAUTH_ENV (development or production) must match whether PUBLIC_URL is a local address. Required once any managed
 * client is set, checked whenever it is set. Returns the reason to refuse to start, or null.
 */
export function oauthEnvProblem(env: Record<string, string | undefined>): string | null {
  const declared = env.OAUTH_ENV ?? "";
  if (!declared) return MANAGED_CLIENT_VARS.some((v) => env[v]) ? "Set OAUTH_ENV to development or production: an OAuth client is configured." : null;
  if (declared !== "development" && declared !== "production") return "OAUTH_ENV must be development or production.";
  let host: string;
  try {
    host = new URL(env.PUBLIC_URL ?? "http://localhost:3000").hostname;
  } catch {
    return "PUBLIC_URL is not a valid URL.";
  }
  const local = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
  if (declared === "development" && !local) return "OAUTH_ENV is development, but PUBLIC_URL is not a local address. Use the production OAuth clients there.";
  if (declared === "production" && local) return "OAUTH_ENV is production, but PUBLIC_URL is a local address. Use the development OAuth clients there.";
  return null;
}
