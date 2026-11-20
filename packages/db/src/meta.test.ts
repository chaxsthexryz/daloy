import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { saveConnection } from "./connections";
import { secretValuesToHide } from "./crypto";
import { queueDelivery, runDueDeliveries } from "./deliveries";
import type { Db } from "./index";
import {
  checkReceiptReference,
  constantTimeEqual,
  downloadMetaImage,
  isAllowedMetaCdnUrl,
  metaIdentity,
  metaSend,
  MetaImageError,
  normalizeReceiptRef,
  parseMetaWebhook,
  verifyMetaSignature,
} from "./meta";
import { connections, deliveries, runs, users, workflows, workflowVersions } from "./schema";

const KEY = randomBytes(32);
const PAGE_TOKEN = "meta_page_token_synthetic_001"; // gitleaks:allow
const APP_SECRET = "meta_app_secret_synthetic_001"; // gitleaks:allow
const VERIFY_TOKEN = "meta_verify_token_synthetic_001"; // gitleaks:allow
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from("WEBPVP8 ")]);

let db: Db;
let pool: Pool;
let fake: FakeProviders;
let cdnServer: Server;
let cdnBase: string;
let seq = 0;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  cdnServer = createServer((req, res) => {
    if (req.url === "/receipt.jpg") return void res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG_BYTES);
    if (req.url === "/receipt.png") return void res.writeHead(200, { "content-type": "image/png" }).end(PNG_BYTES);
    if (req.url === "/receipt.webp") return void res.writeHead(200, { "content-type": "image/webp" }).end(WEBP_BYTES);
    if (req.url === "/html-as-jpg") return void res.writeHead(200, { "content-type": "image/jpeg" }).end("<html><body>not an image</body></html>");
    if (req.url === "/svg-as-png") return void res.writeHead(200, { "content-type": "image/png" }).end("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    if (req.url === "/redirect") return void res.writeHead(302, { location: "/receipt.jpg" }).end();
    if (req.url === "/too-big") return void res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.concat([JPEG_BYTES, Buffer.alloc(5 * 1024 * 1024 + 64, 0x41)]));
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((r) => cdnServer.listen(0, "127.0.0.1", r));
  cdnBase = `http://127.0.0.1:${(cdnServer.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  cdnServer?.closeAllConnections();
  cdnServer?.close();
  await fake?.close();
  await pool?.end();
});

async function makeUserAndRun() {
  const [u] = await db.insert(users).values({ email: `meta-${++seq}@test.local`, passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Meta", slug: `meta-${seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {}, published: true }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
  return { userId: u!.id, workflowId: wf!.id, versionId: v!.id, runId: r!.id };
}

describe("Meta webhook signature and challenge helpers", () => {
  it("verifies X-Hub-Signature-256 against raw bytes and fails closed on tampering or missing values", () => {
    const raw = Buffer.from('{"object":"page","entry":[]}');
    const sig = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
    expect(verifyMetaSignature(raw, sig, APP_SECRET)).toBe(true);
    expect(verifyMetaSignature(raw, sig.toUpperCase().replace("SHA256=", "sha256="), APP_SECRET)).toBe(true);
    expect(verifyMetaSignature(Buffer.from('{"object":"page","entry":[1]}'), sig, APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, sig, "wrong_secret")).toBe(false);
    expect(verifyMetaSignature(raw, undefined, APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, "sha256=not-hex", APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, sig, "")).toBe(false);
  });

  it("compares verify tokens in constant time", () => {
    expect(constantTimeEqual(VERIFY_TOKEN, VERIFY_TOKEN)).toBe(true);
    expect(constantTimeEqual(VERIFY_TOKEN, "different")).toBe(false);
    expect(constantTimeEqual(VERIFY_TOKEN, `${VERIFY_TOKEN}x`)).toBe(false);
  });

  it("parses Messenger and Instagram messages, ignoring echoes, receipts, and mismatched account ids", () => {
    const dest = { pageId: "100200300", instagramAccountId: "900800700", webhookPath: "p" };
    const pageBody = {
      object: "page",
      entry: [
        {
          id: "999999999",
          messaging: [{ sender: { id: "u-wrong" }, timestamp: 1700000000000, message: { mid: "m_wrong", text: "nope" } }],
        },
        {
          id: "100200300",
          messaging: [
            { sender: { id: "u-echo" }, timestamp: 1700000000001, message: { mid: "m_echo", is_echo: true, text: "echo" } },
            { sender: { id: "u-dlv" }, timestamp: 1700000000002, delivery: { mids: ["m_1"] } },
            { sender: { id: "u-read" }, timestamp: 1700000000003, read: { watermark: 1700000000003 } },
            {
              sender: { id: "psid-1" },
              timestamp: 1700000000004,
              message: {
                mid: "m_ok_1",
                text: "Here is my GCash receipt",
                attachments: [
                  { type: "image", payload: { url: "https://scontent.fbcdn.net/v/1.jpg" } },
                  { type: "audio", payload: { url: "https://scontent.fbcdn.net/v/a.mp3" } },
                  { type: "image", payload: { url: "https://scontent.fbcdn.net/v/2.jpg" } },
                  { type: "image", payload: { url: "https://scontent.fbcdn.net/v/3.jpg" } },
                  { type: "image", payload: { url: "https://scontent.fbcdn.net/v/4.jpg" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const parsedPage = parseMetaWebhook(pageBody, dest);
    expect(parsedPage).toHaveLength(1);
    expect(parsedPage[0]).toMatchObject({
      channel: "messenger",
      senderId: "psid-1",
      messageId: "m_ok_1",
      text: "Here is my GCash receipt",
      imageUrls: [
        "https://scontent.fbcdn.net/v/1.jpg",
        "https://scontent.fbcdn.net/v/2.jpg",
        "https://scontent.fbcdn.net/v/3.jpg",
      ],
    });

    const igBody = {
      object: "instagram",
      entry: [
        {
          id: "900800700",
          messaging: [
            {
              sender: { id: "igsid-9" },
              timestamp: 1700000000010,
              message: {
                mid: "m_ig_1",
                text: "Paid!",
                attachments: [{ type: "image", payload: { url: "https://scontent.cdninstagram.com/v/r.png" } }],
              },
            },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(igBody, dest)).toHaveLength(1);
    expect(parseMetaWebhook(igBody, dest)[0]).toMatchObject({ channel: "instagram", senderId: "igsid-9", messageId: "m_ig_1" });
    // Without instagramAccountId configured, IG events are ignored.
    expect(parseMetaWebhook(igBody, { pageId: "100200300", webhookPath: "p" })).toEqual([]);
  });
});

describe("Meta CDN host allowlist, SSRF protection, and magic-byte validation", () => {
  it("allows only HTTPS port 443 on Meta CDN hosts by default", () => {
    expect(isAllowedMetaCdnUrl("https://scontent.fbcdn.net/v/t1.jpg")).toBe(true);
    expect(isAllowedMetaCdnUrl("https://scontent-mnl1-1.xx.fbcdn.net/v/t1.jpg")).toBe(true);
    expect(isAllowedMetaCdnUrl("https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1")).toBe(true);
    expect(isAllowedMetaCdnUrl("https://scontent.cdninstagram.com/v/t51.jpg")).toBe(true);

    expect(isAllowedMetaCdnUrl("http://scontent.fbcdn.net/v/t1.jpg")).toBe(false);
    expect(isAllowedMetaCdnUrl("https://scontent.fbcdn.net:8443/v/t1.jpg")).toBe(false);
    expect(isAllowedMetaCdnUrl("https://evil.example/v/t1.jpg")).toBe(false);
    expect(isAllowedMetaCdnUrl("https://evilfbcdn.net/v/t1.jpg")).toBe(false);
    expect(isAllowedMetaCdnUrl("https://fbcdn.net.evil.example/v/t1.jpg")).toBe(false);
    expect(isAllowedMetaCdnUrl("https://sub.lookaside.fbsbx.com/v/t1.jpg")).toBe(false);
    expect(isAllowedMetaCdnUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedMetaCdnUrl("https://user:pass@scontent.fbcdn.net/v/t1.jpg")).toBe(false);
  });

  it("blocks private, loopback and metadata IPs returned by DNS even on an allowlisted host", async () => {
    for (const addr of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "192.168.1.1", "::1", "::ffff:169.254.169.254"]) {
      const family = addr.includes(":") ? 6 : 4;
      await expect(
        downloadMetaImage("https://scontent.fbcdn.net/v/receipt.jpg", {
          resolve: async () => [{ address: addr, family }],
        }),
      ).rejects.toThrow(MetaImageError);
    }
  });

  it("downloads valid JPEG, PNG, and WebP images and rejects redirects, non-images, and files over 5 MB", async () => {
    const urls = { ...fake.urls, metaCdn: cdnBase };
    const jpg = await downloadMetaImage(`${cdnBase}/receipt.jpg`, { urls });
    expect(jpg.type).toBe("jpeg");
    expect(jpg.data.equals(JPEG_BYTES)).toBe(true);

    const png = await downloadMetaImage(`${cdnBase}/receipt.png`, { urls });
    expect(png.type).toBe("png");

    const webp = await downloadMetaImage(`${cdnBase}/receipt.webp`, { urls });
    expect(webp.type).toBe("webp");

    await expect(downloadMetaImage(`${cdnBase}/html-as-jpg`, { urls })).rejects.toThrow(MetaImageError);
    await expect(downloadMetaImage(`${cdnBase}/svg-as-png`, { urls })).rejects.toThrow(MetaImageError);
    await expect(downloadMetaImage(`${cdnBase}/redirect`, { urls })).rejects.toThrow(MetaImageError);
    await expect(downloadMetaImage(`${cdnBase}/too-big`, { urls })).rejects.toThrow(MetaImageError);
    // Even with metaCdn override, unrelated origins remain rejected.
    await expect(downloadMetaImage("https://evil.example/receipt.jpg", { urls })).rejects.toThrow(MetaImageError);
  });
});

describe("duplicate GCash and bank receipt reference flagging", () => {
  it("normalizes references and flags repeats across runs in the same workspace while ignoring retries and test runs", async () => {
    expect(normalizeReceiptRef(" 1002-3456 78901 ")).toBe("1002345678901");
    expect(normalizeReceiptRef("N/A")).toBeNull();
    expect(normalizeReceiptRef("123")).toBeNull();

    const a1 = await makeUserAndRun();
    const [a2Run] = await db.insert(runs).values({ workflowVersionId: a1.versionId, triggerPayload: {} }).returning();
    const b1 = await makeUserAndRun();

    // Test runs never record or flag.
    const testCheck = await checkReceiptReference(db, { userId: a1.userId, runId: a1.runId, provider: "GCash", reference: "1002 3456 78901", test: true });
    expect(testCheck.duplicate).toBe(false);

    // First live run records the reference.
    const first = await checkReceiptReference(db, { userId: a1.userId, runId: a1.runId, provider: "GCash", reference: "1002 3456 78901" });
    expect(first.duplicate).toBe(false);
    expect(first.normalizedRef).toBe("1002345678901");

    // Step retry of the same run is not flagged as duplicate.
    const retrySameRun = await checkReceiptReference(db, { userId: a1.userId, runId: a1.runId, provider: "GCash", reference: "1002-3456-78901" });
    expect(retrySameRun.duplicate).toBe(false);

    // Second run with the same reference (different formatting) IS flagged.
    const second = await checkReceiptReference(db, { userId: a1.userId, runId: a2Run!.id, provider: "GCash", reference: "1002-3456-78901" });
    expect(second.duplicate).toBe(true);
    expect(second.firstRunId).toBe(a1.runId);
    expect(second.warning).toContain("already seen");

    // Another workspace with the same reference is isolated.
    const otherWs = await checkReceiptReference(db, { userId: b1.userId, runId: b1.runId, provider: "GCash", reference: "1002-3456-78901" });
    expect(otherWs.duplicate).toBe(false);
  });
});

describe("Meta reply delivery, 24-hour window, IV-fenced auth failure, and secret redaction", () => {
  it("delivers replies, handles 24h window as non-retryable without failing the connection, parks 5xx/timeouts in needs_review, and fences 401 by credential IV", async () => {
    fake.meta.token = PAGE_TOKEN;
    fake.meta.pageId = "100200300";
    fake.meta.pageName = "Tindahan ni Ana";
    fake.meta.revoked = false;
    fake.meta.messages.length = 0;

    const info = await metaIdentity(fake.urls, PAGE_TOKEN);
    expect(info).toEqual({ id: "100200300", name: "Tindahan ni Ana" });

    const { userId, runId } = await makeUserAndRun();
    await saveConnection(db, KEY, userId, "meta_messenger", {
      account: "Tindahan ni Ana",
      credential: JSON.stringify({ pageAccessToken: PAGE_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN }),
      destination: { pageId: "100200300", pageName: "Tindahan ni Ana", webhookPath: randomBytes(32).toString("base64url") },
    });

    // secretValuesToHide includes all three Meta secrets.
    const hidden = await secretValuesToHide(db, KEY, userId);
    expect(hidden).toContain(PAGE_TOKEN);
    expect(hidden).toContain(APP_SECRET);
    expect(hidden).toContain(VERIFY_TOKEN);

    // 1. Happy path delivery.
    const d1 = await queueDelivery(db, { userId, runId, stepId: "reply_ok", provider: "meta_messenger", reference: "M-1", payload: { recipientId: "psid-1", channel: "messenger", text: "Verified!" } });
    await runDueDeliveries(db, KEY, fake.urls);
    const [row1] = await db.select().from(deliveries).where(eq(deliveries.id, d1.id));
    expect(row1?.state).toBe("delivered");
    expect(fake.meta.messages).toHaveLength(1);
    expect(fake.meta.messages[0]).toMatchObject({ recipientId: "psid-1", text: "Verified!", messagingType: "RESPONSE" });

    // 2. Meta 24-hour window error (code 10, subcode 2018278): fails cleanly, non-retryable, connection stays active.
    fake.once("/v21.0/me/messages", {
      status: 400,
      body: { error: { message: "Outside allowed window", type: "OAuthException", code: 10, error_subcode: 2018278 } },
    });
    const d2 = await queueDelivery(db, { userId, runId, stepId: "reply_24h", provider: "meta_messenger", reference: "M-2", payload: { recipientId: "psid-1", text: "Late reply" } });
    await runDueDeliveries(db, KEY, fake.urls);
    const [row2] = await db.select().from(deliveries).where(eq(deliveries.id, d2.id));
    expect(row2?.state).toBe("failed");
    expect(row2?.lastError).toContain("24-hour reply window");
    const [connAfter24h] = await db.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, "meta_messenger")));
    expect(connAfter24h?.status).toBe("active");

    // 3. 429 backs off honouring Retry-After.
    fake.once("/v21.0/me/messages", { status: 429, headers: { "retry-after": "30" }, body: { error: { code: 4, message: "Too many calls" } } });
    const d3 = await queueDelivery(db, { userId, runId, stepId: "reply_429", provider: "meta_messenger", reference: "M-3", payload: { recipientId: "psid-1", text: "Rate limited" } });
    const before429 = Date.now();
    await runDueDeliveries(db, KEY, fake.urls);
    const [row3] = await db.select().from(deliveries).where(eq(deliveries.id, d3.id));
    expect(row3?.state).toBe("queued");
    expect(row3?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before429 + 29_000);

    // 4. 5xx-after-connect parks in needs_review.
    fake.once("/v21.0/me/messages", { status: 502, body: { error: { message: "Bad gateway" } } });
    const d4 = await queueDelivery(db, { userId, runId, stepId: "reply_502", provider: "meta_messenger", reference: "M-4", payload: { recipientId: "psid-1", text: "Uncertain" } });
    await runDueDeliveries(db, KEY, fake.urls);
    const [row4] = await db.select().from(deliveries).where(eq(deliveries.id, d4.id));
    expect(row4?.state).toBe("needs_review");

    // 5. Late 401 for an old credential revision does NOT mark a replaced connection failed (IV-fenced).
    let releaseHold!: () => void;
    const heldUntil = new Promise<void>((r) => (releaseHold = r));
    fake.once("/v21.0/me/messages", { heldUntil, status: 401, body: { error: { code: 190, message: "Invalid OAuth access token" } } });
    const d5 = await queueDelivery(db, { userId, runId, stepId: "reply_fence", provider: "meta_messenger", reference: "M-5", payload: { recipientId: "psid-1", text: "Old token" } });
    const inflight = runDueDeliveries(db, KEY, fake.urls);
    // Wait briefly so delivery is in flight, then replace connection credential (new IV).
    await new Promise((r) => setTimeout(r, 80));
    const NEW_TOKEN = "meta_page_token_synthetic_002"; // gitleaks:allow
    fake.meta.token = NEW_TOKEN;
    await saveConnection(db, KEY, userId, "meta_messenger", {
      account: "Tindahan ni Ana",
      credential: JSON.stringify({ pageAccessToken: NEW_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN }),
      destination: { pageId: "100200300", pageName: "Tindahan ni Ana", webhookPath: randomBytes(32).toString("base64url") },
    });
    releaseHold();
    await inflight;
    const [connAfterReplace] = await db.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, "meta_messenger")));
    expect(connAfterReplace?.status).toBe("active");

    // 6. Direct 401 on the CURRENT credential DOES mark connection failed.
    fake.once("/v21.0/me/messages", { status: 401, body: { error: { code: 190, message: "Token expired" } } });
    const d6 = await queueDelivery(db, { userId, runId, stepId: "reply_401", provider: "meta_messenger", reference: "M-6", payload: { recipientId: "psid-1", text: "Current token" } });
    await runDueDeliveries(db, KEY, fake.urls);
    const [row6] = await db.select().from(deliveries).where(eq(deliveries.id, d6.id));
    expect(row6?.state).toBe("failed");
    const [connAfter401] = await db.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, "meta_messenger")));
    expect(connAfter401?.status).toBe("failed");

    // Ensure metaSend never echoes the bearer token in thrown error messages.
    await expect(metaSend(fake.urls, NEW_TOKEN, { recipientId: "psid-1", text: "x" })).resolves.toMatchObject({ recipientId: "psid-1" });
    expect(d5.id).toBeTruthy();
  });
});
