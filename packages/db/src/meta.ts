import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { FILE_MAX_BYTES, FILES_PER_FIELD, fileType, safeFileName } from "@daloy/engine";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index";
import { call, ProviderError, providerUrls, retryAfter, type ProviderUrls, type Reply } from "./providers";
import { receiptReferences } from "./schema";

export type MetaCredential = {
  pageAccessToken: string;
  appSecret: string;
  verifyToken: string;
};

export type MetaDestination = {
  pageId: string;
  pageName?: string;
  instagramAccountId?: string;
  webhookPath: string;
};

export type MetaChannel = "messenger" | "instagram";

export type MetaIncomingMessage = {
  channel: MetaChannel;
  senderId: string;
  messageId: string;
  text: string;
  timestamp: string;
  imageUrls: string[];
};

export class MetaImageError extends Error {
  override name = "MetaImageError";
}

/** Transient Meta CDN failure (network timeout, HTTP 429, or 5xx): webhook returns 503 so Meta retries before run_keys is committed. */
export class MetaTransientImageError extends Error {
  override name = "MetaTransientImageError";
}

/** Parses the encrypted JSON credential for a meta_messenger connection. */
export function parseMetaCredential(raw: string): MetaCredential {
  try {
    const parsed = JSON.parse(raw) as Partial<MetaCredential> | null;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.pageAccessToken === "string" &&
      typeof parsed.appSecret === "string" &&
      typeof parsed.verifyToken === "string"
    ) {
      return { pageAccessToken: parsed.pageAccessToken, appSecret: parsed.appSecret, verifyToken: parsed.verifyToken };
    }
  } catch {
    // malformed JSON
  }
  throw new ProviderError("Stored Meta credentials could not be read. Connect Facebook Messenger & Instagram again.", "auth");
}

/** Constant-time string comparison using SHA-256 digests so lengths are not leaked by timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Verifies Meta's X-Hub-Signature-256 header ("sha256=<hex>") against raw request bytes with timingSafeEqual.
 * Fails closed on empty secret, missing header, or non-hex digest.
 */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(m[1]!, "hex");
  return given.length === expected.length && timingSafeEqual(expected, given);
}

/**
 * Extracts incoming Messenger (object = "page") and Instagram (object = "instagram") DM events matching the connected
 * Page ID or Instagram Business Account ID. Ignores echoes, delivery/read receipts, and unlinked accounts.
 */
export function parseMetaWebhook(body: unknown, dest: Partial<MetaDestination> | null | undefined): MetaIncomingMessage[] {
  if (!body || typeof body !== "object" || !dest) return [];
  const obj = body as { object?: unknown; entry?: unknown };
  let channel: MetaChannel;
  let expectedId: string | undefined;
  if (obj.object === "page") {
    channel = "messenger";
    expectedId = dest.pageId;
  } else if (obj.object === "instagram") {
    channel = "instagram";
    expectedId = dest.instagramAccountId;
  } else {
    return [];
  }
  if (!expectedId || !Array.isArray(obj.entry)) return [];

  const out: MetaIncomingMessage[] = [];
  for (const rawEntry of obj.entry) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as { id?: unknown; messaging?: unknown };
    if (String(entry.id ?? "") !== expectedId) continue;
    if (!Array.isArray(entry.messaging)) continue;
    for (const rawEv of entry.messaging) {
      if (!rawEv || typeof rawEv !== "object") continue;
      const ev = rawEv as {
        sender?: { id?: unknown };
        timestamp?: unknown;
        message?: {
          mid?: unknown;
          text?: unknown;
          is_echo?: unknown;
          attachments?: unknown;
        };
      };
      if (!ev.message || typeof ev.message !== "object") continue;
      if (ev.message.is_echo === true) continue;
      const mid = typeof ev.message.mid === "string" ? ev.message.mid.trim() : "";
      const senderId = ev.sender?.id !== undefined && ev.sender?.id !== null ? String(ev.sender.id).trim() : "";
      if (!mid || !senderId) continue;
      if (senderId === expectedId || senderId === dest.pageId || (dest.instagramAccountId && senderId === dest.instagramAccountId)) continue;
      const text = typeof ev.message.text === "string" ? ev.message.text : "";
      const imageUrls: string[] = [];
      if (Array.isArray(ev.message.attachments)) {
        for (const att of ev.message.attachments) {
          if (imageUrls.length >= FILES_PER_FIELD) break;
          if (!att || typeof att !== "object") continue;
          const a = att as { type?: unknown; payload?: { url?: unknown } };
          if (a.type === "image" && typeof a.payload?.url === "string" && a.payload.url.trim()) {
            imageUrls.push(a.payload.url.trim());
          }
        }
      }
      const ts = typeof ev.timestamp === "number" && Number.isFinite(ev.timestamp) ? new Date(ev.timestamp).toISOString() : new Date().toISOString();
      out.push({ channel, senderId, messageId: mid, text, timestamp: ts, imageUrls });
    }
  }
  return out;
}

// ---------------------------------------------------------------- Meta CDN image download (SSRF-protected, magic-byte checked)

const BLOCKED_RANGES: [network: string, prefix: number, family: "ipv4" | "ipv6"][] = [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
];

const BLOCK_LIST = (() => {
  const list = new BlockList();
  for (const [net, prefix, family] of BLOCKED_RANGES) list.addSubnet(net, prefix, family);
  return list;
})();

const isBlockedIp = (address: string) => {
  const family = isIP(address);
  return family === 0 || BLOCK_LIST.check(address, family === 4 ? "ipv4" : "ipv6");
};

const VALID_DNS_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function isMetaCdnOverride(url: URL, urls?: ProviderUrls): boolean {
  if (!urls?.metaCdn) return false;
  try {
    return url.origin === new URL(urls.metaCdn).origin;
  } catch {
    return false;
  }
}

/**
 * Allows only https:// on port 443 for Meta's image CDN hosts (*.fbcdn.net, lookaside.fbsbx.com, *.cdninstagram.com),
 * or the exact test origin configured in ProviderUrls.metaCdn. Never allows arbitrary URLs or credentials in the URL.
 */
export function isAllowedMetaCdnUrl(raw: string, urls?: ProviderUrls): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (isMetaCdnOverride(u, urls)) return true;
  if (u.protocol !== "https:") return false;
  if (u.port !== "" && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  if (isIP(host.replace(/^\[(.*)\]$/, "$1")) !== 0) return false;
  if (!VALID_DNS_HOST.test(host)) return false;
  return host === "lookaside.fbsbx.com" || host.endsWith(".fbcdn.net") || host.endsWith(".cdninstagram.com");
}

export type MetaImageResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
export type AllowedMetaImageType = "jpeg" | "png" | "webp";
const ALLOWED_IMAGE_TYPES = new Set<string>(["jpeg", "png", "webp"]);
const EXT_FOR_TYPE: Record<AllowedMetaImageType, string> = { jpeg: "jpg", png: "png", webp: "webp" };

function guardedLookup(resolve: MetaImageResolver): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (err: Error | null, address?: unknown, family?: number) => void) => {
    resolve(hostname).then(
      (addrs) => {
        if (addrs.length === 0) return callback(new MetaImageError(`${hostname} did not resolve`));
        if (addrs.some((a) => isBlockedIp(a.address))) return callback(new MetaImageError(`${hostname} resolved to a blocked address`));
        if (options.all) return callback(null, addrs);
        callback(null, addrs[0]!.address, addrs[0]!.family);
      },
      (err: Error) => callback(err),
    );
  }) as LookupFunction;
}

const MAX_CONCURRENT_META_DOWNLOADS = 4;
let activeMetaDownloads = 0;
const metaDownloadQueue: (() => void)[] = [];

async function withDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeMetaDownloads >= MAX_CONCURRENT_META_DOWNLOADS) {
    await new Promise<void>((resolve) => metaDownloadQueue.push(resolve));
  }
  activeMetaDownloads++;
  try {
    return await fn();
  } finally {
    activeMetaDownloads--;
    metaDownloadQueue.shift()?.();
  }
}

/**
 * Downloads one Meta image attachment with strict host allowlisting, IP-pinned DNS SSRF checks, no redirects,
 * 5 MB streaming size limit, 10s timeout, and magic-byte verification (JPEG, PNG, WebP only).
 */
export async function downloadMetaImage(
  rawUrl: string,
  opts: { urls?: ProviderUrls; resolve?: MetaImageResolver; timeoutMs?: number; maxBytes?: number; index?: number } = {},
): Promise<{ name: string; type: AllowedMetaImageType; data: Buffer }> {
  if (!isAllowedMetaCdnUrl(rawUrl, opts.urls)) {
    throw new MetaImageError("Image URL is not an allowed Meta CDN address.");
  }
  const url = new URL(rawUrl);
  const testOverride = isMetaCdnOverride(url, opts.urls);
  const timeoutMs = opts.timeoutMs ?? opts.urls?.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? FILE_MAX_BYTES;
  const resolve: MetaImageResolver = opts.resolve ?? ((hostname) => dnsLookup(hostname, { all: true, order: "verbatim" }));

  return withDownloadSlot(async () => {
    const res = await new Promise<IncomingMessage>((resolveReq, rejectReq) => {
      const req = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method: "GET",
          agent: false,
          signal: AbortSignal.timeout(timeoutMs),
          ...(testOverride ? {} : { lookup: guardedLookup(resolve) }),
        },
        resolveReq,
      );
      req.on("error", (err) => rejectReq(err instanceof MetaImageError ? err : new MetaTransientImageError(`Could not download Meta image: ${err.message}`)));
      req.end();
    });

    const status = res.statusCode ?? 0;
    if (status === 429 || status >= 500) {
      res.destroy();
      throw new MetaTransientImageError(`Meta image CDN answered HTTP ${status}.`);
    }
    if (status >= 300 && status < 400) {
      res.destroy();
      throw new MetaImageError("Redirects are not allowed when downloading Meta images.");
    }
    if (status !== 200) {
      res.destroy();
      throw new MetaImageError(`Meta image download returned HTTP ${status}.`);
    }
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      throw new MetaImageError(`Image is larger than ${maxBytes} bytes.`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of res as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          throw new MetaImageError(`Image is larger than ${maxBytes} bytes.`);
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof MetaImageError) throw err;
      throw new MetaTransientImageError(`Meta image stream interrupted: ${err instanceof Error ? err.message : String(err)}`);
    }
    const data = Buffer.concat(chunks);
    const kind = fileType(data);
    if (!kind || !ALLOWED_IMAGE_TYPES.has(kind)) {
      throw new MetaImageError("Attachment is not a JPEG, PNG or WebP image.");
    }
    const imageType = kind as AllowedMetaImageType;
    const idx = opts.index ?? 1;
    return { name: safeFileName(`receipt-${idx}.${EXT_FOR_TYPE[imageType]}`), type: imageType, data };
  });
}

// ---------------------------------------------------------------- Duplicate GCash / bank receipt reference flagging

const IGNORE_REFS = new Set(["NA", "NONE", "NULL", "UNKNOWN", "PENDING", "SAMPLE", "MOCKREFERENCE"]);

/** Strips whitespace and punctuation, uppercases, and returns null for missing or trivial values (< 6 alphanumeric chars). */
export function normalizeReceiptRef(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (cleaned.length < 6 || IGNORE_REFS.has(cleaned)) return null;
  return cleaned;
}

export type ReceiptRefCheck = {
  duplicate: boolean;
  normalizedRef: string | null;
  firstRunId: string | null;
  warning: string;
};

const DUPLICATE_WARNING = "WARNING: This receipt reference number was already seen in an earlier run. Check your real GCash or bank inbox carefully before approving.";

/**
 * Records a normalized receipt reference for the workspace on first sight. Returns duplicate: true when a different
 * live run in the same workspace already recorded the same reference. Retries of the first run and test runs are not flagged.
 */
export async function checkReceiptReference(
  db: Db,
  input: { userId: string; runId: string; provider?: string | null; reference?: string | null; test?: boolean },
): Promise<ReceiptRefCheck> {
  if (input.test) return { duplicate: false, normalizedRef: null, firstRunId: null, warning: "" };
  const normalizedRef = normalizeReceiptRef(input.reference);
  if (!normalizedRef) return { duplicate: false, normalizedRef: null, firstRunId: null, warning: "" };

  const inserted = await db
    .insert(receiptReferences)
    .values({ userId: input.userId, normalizedRef, provider: input.provider ?? null, firstRunId: input.runId })
    .onConflictDoNothing({ target: [receiptReferences.userId, receiptReferences.normalizedRef] })
    .returning({ firstRunId: receiptReferences.firstRunId });

  if (inserted.length === 1) {
    return { duplicate: false, normalizedRef, firstRunId: input.runId, warning: "" };
  }
  const [existing] = await db
    .select({ firstRunId: receiptReferences.firstRunId })
    .from(receiptReferences)
    .where(and(eq(receiptReferences.userId, input.userId), eq(receiptReferences.normalizedRef, normalizedRef)));

  if (!existing || existing.firstRunId === input.runId) {
    return { duplicate: false, normalizedRef, firstRunId: input.runId, warning: "" };
  }
  return { duplicate: true, normalizedRef, firstRunId: existing.firstRunId, warning: DUPLICATE_WARNING };
}

// ---------------------------------------------------------------- Meta Graph API (v21.0)

function metaFailure(res: Reply, write: boolean): ProviderError {
  const err = (res.body.error ?? {}) as { code?: unknown; error_subcode?: unknown };
  const code = Number(err.code);
  const subcode = Number(err.error_subcode);

  // Meta 24-hour standard messaging window error: fail cleanly as non-retryable without marking connection failed.
  if (subcode === 2018278 || (code === 10 && subcode === 2018278)) {
    return new ProviderError("Past Meta's 24-hour reply window. Reply directly from your Facebook Page or Instagram inbox.", "invalid");
  }
  if (res.status === 429 || code === 4 || code === 17 || code === 613) {
    return new ProviderError("Meta is limiting requests right now. Daloy will try again.", "quota", retryAfter(res.headers));
  }
  if (res.status >= 500) {
    return new ProviderError(`Meta answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  }
  if (res.status === 401 || res.status === 403 || code === 190) {
    return new ProviderError("Meta no longer accepts the Page access token. Connect Facebook Messenger & Instagram again.", "auth");
  }
  return new ProviderError("Meta refused the message. Check the recipient id and Page messaging permissions.", "invalid");
}

/** Validates a Page access token against Meta Graph API GET /v21.0/me?fields=id,name,instagram_business_account. */
export async function metaIdentity(urls: ProviderUrls = providerUrls(), pageAccessToken: string): Promise<{ id: string; name: string; instagramAccountId?: string }> {
  const base = urls.meta ?? "https://graph.facebook.com";
  const res = await call(
    `${base}/v21.0/me?fields=id,name,instagram_business_account`,
    { method: "GET", headers: { authorization: `Bearer ${pageAccessToken}`, accept: "application/json" } },
    urls.timeoutMs ?? 10_000,
    false,
    "Meta",
  );
  if (res.status !== 200) throw metaFailure(res, false);
  const id = String(res.body.id ?? "").trim();
  const name = String(res.body.name ?? id);
  if (!id) throw new ProviderError("Meta did not return a Page id for that token.", "auth");
  const igObj = res.body.instagram_business_account;
  const igId = igObj && typeof igObj === "object" && typeof (igObj as { id?: unknown }).id === "string" ? (igObj as { id: string }).id.trim() : "";
  return { id, name, ...(igId ? { instagramAccountId: igId } : {}) };
}

/** Sends a Messenger or Instagram DM reply within Meta's 24-hour standard messaging window. */
export async function metaSend(
  urls: ProviderUrls = providerUrls(),
  pageAccessToken: string,
  msg: { recipientId: string; channel?: string; text: string },
): Promise<{ recipientId: string; messageId: string }> {
  const base = urls.meta ?? "https://graph.facebook.com";
  const res = await call(
    `${base}/v21.0/me/messages`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${pageAccessToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        recipient: { id: msg.recipientId },
        messaging_type: "RESPONSE",
        message: { text: msg.text },
      }),
    },
    urls.timeoutMs ?? 10_000,
    true,
    "Meta",
  );
  if (res.status !== 200) throw metaFailure(res, true);
  const messageId = typeof res.body.message_id === "string" ? res.body.message_id.trim() : "";
  if (!messageId) {
    throw new ProviderError("Meta returned an unexpected response without a message ID, so Daloy cannot tell whether the reply went through.", "ambiguous");
  }
  return {
    recipientId: String(res.body.recipient_id ?? msg.recipientId),
    messageId,
  };
}
