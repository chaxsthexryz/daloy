import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../test/fake-providers";
import { saveConnection } from "./connections";
import { secretValuesToHide } from "./crypto";
import { queueDelivery, runDueDeliveries } from "./deliveries";
import type { Db } from "./index";
import { connections, deliveries, runs, users, workflows, workflowVersions } from "./schema";
import {
  downloadWhatsAppMedia,
  normalizeWhatsAppPhone,
  parseWhatsAppCredential,
  parseWhatsAppWebhook,
  whatsappIdentity,
  whatsappSend,
} from "./whatsapp";

const KEY = randomBytes(32);
const PHONE_NUMBER_ID = "9988776655";
const ACCESS_TOKEN = "wa_system_user_token_synthetic_001"; // gitleaks:allow
const APP_SECRET = "wa_app_secret_synthetic_001"; // gitleaks:allow
const VERIFY_TOKEN = "wa_verify_token_synthetic_001"; // gitleaks:allow
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let db: Db;
let pool: Pool;
let fake: FakeProviders;
let seq = 0;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await pool?.end();
});

beforeEach(() => {
  fake.whatsapp.token = ACCESS_TOKEN;
  fake.whatsapp.phoneNumberId = PHONE_NUMBER_ID;
  fake.whatsapp.displayPhone = "+63 917 000 0999";
  fake.whatsapp.verifiedName = "kymavo Resort";
  fake.whatsapp.revoked = false;
  fake.whatsapp.messages.length = 0;
  fake.whatsapp.media.clear();
  fake.meta.cdnFiles.set("wa-receipt.png", { contentType: "image/png", data: PNG_BYTES });
  fake.whatsapp.media.set("wa-media-1", { url: `${fake.urls.metaCdn}/meta-cdn/wa-receipt.png` });
});

async function makeUserAndRun() {
  const [u] = await db.insert(users).values({ email: `wa-db-${++seq}@test.local`, passwordHash: "x" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "WA", slug: `wa-db-${seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {}, published: true }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
  return { userId: u!.id, runId: r!.id };
}

describe("WhatsApp credential, phone normalization, and webhook parser", () => {
  it("parses credentials and rejects malformed or missing secrets", () => {
    expect(parseWhatsAppCredential(JSON.stringify({ accessToken: ACCESS_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN }))).toEqual({
      accessToken: ACCESS_TOKEN,
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
    });
    expect(() => parseWhatsAppCredential("not-json")).toThrow(/Stored WhatsApp credentials/);
    expect(() => parseWhatsAppCredential(JSON.stringify({ accessToken: ACCESS_TOKEN }))).toThrow(/Stored WhatsApp credentials/);
  });

  it("normalizes Philippine and E.164 WhatsApp phone numbers", () => {
    expect(normalizeWhatsAppPhone("0917 123 4567")).toBe("639171234567");
    expect(normalizeWhatsAppPhone("+63 (917) 123-4567")).toBe("639171234567");
    expect(normalizeWhatsAppPhone("9171234567")).toBe("639171234567");
    expect(normalizeWhatsAppPhone("14155550123")).toBe("14155550123");
    expect(normalizeWhatsAppPhone("123")).toBeNull();
  });

  it("parses text, image, interactive choices, and ignores status callbacks or other phone_number_ids", () => {
    const dest = { phoneNumberId: PHONE_NUMBER_ID, webhookPath: "wa-hook" };
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "other-phone-id" },
                messages: [{ id: "wamid.other", from: "639171111111", timestamp: "1700000000", type: "text", text: { body: "wrong phone" } }],
              },
            },
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                statuses: [{ id: "wamid.status", status: "delivered" }],
                contacts: [{ wa_id: "639171234567", profile: { name: "Ana Reyes" } }],
                messages: [
                  { id: "wamid.txt1", from: "639171234567", timestamp: "1700000001", type: "text", text: { body: "Hello!" } },
                  {
                    id: "wamid.img1",
                    from: "639171234567",
                    timestamp: "1700000002",
                    type: "image",
                    image: { id: "wa-media-1", caption: "GCash ref 1002555888" },
                  },
                  {
                    id: "wamid.btn1",
                    from: "639171234567",
                    timestamp: "1700000003",
                    type: "interactive",
                    interactive: { type: "button_reply", button_reply: { id: "book", title: "Book a room" } },
                  },
                  {
                    id: "wamid.badchoice",
                    from: "639171234567",
                    timestamp: "1700000004",
                    type: "interactive",
                    interactive: { type: "list_reply", list_reply: { id: "../evil", title: "Weird choice" } },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const parsed = parseWhatsAppWebhook(body, dest);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toMatchObject({ senderId: "639171234567", senderName: "Ana Reyes", messageId: "wamid.txt1", text: "Hello!", mediaIds: [] });
    expect(parsed[1]).toMatchObject({ senderId: "639171234567", messageId: "wamid.img1", text: "GCash ref 1002555888", mediaIds: ["wa-media-1"] });
    expect(parsed[2]).toMatchObject({ senderId: "639171234567", messageId: "wamid.btn1", text: "Book a room", choice: "book" });
    expect(parsed[3]!.choice).toBeUndefined();
  });
});

describe("WhatsApp Cloud API client and delivery runner", () => {
  it("validates identity, downloads Bearer-authenticated media, sends text/buttons/templates, and maps errors", async () => {
    const info = await whatsappIdentity(fake.urls, ACCESS_TOKEN, PHONE_NUMBER_ID);
    expect(info).toEqual({ id: PHONE_NUMBER_ID, displayPhone: "+63 917 000 0999", verifiedName: "kymavo Resort" });

    const img = await downloadWhatsAppMedia(fake.urls, ACCESS_TOKEN, "wa-media-1");
    expect(img.type).toBe("png");
    expect(img.data.equals(PNG_BYTES)).toBe(true);

    // Interactive quick replies: <=3 become interactive buttons, >3 fall back to a numbered text list.
    await whatsappSend(fake.urls, ACCESS_TOKEN, PHONE_NUMBER_ID, {
      mode: "text",
      to: "639171234567",
      text: "Choose one",
      quickReplies: [
        { choice: "book", title: "Book" },
        { choice: "rates", title: "Rates" },
      ],
    });
    expect(fake.whatsapp.messages[0]).toMatchObject({ type: "interactive", to: "639171234567" });

    await whatsappSend(fake.urls, ACCESS_TOKEN, PHONE_NUMBER_ID, {
      mode: "text",
      to: "639171234567",
      text: "Pick",
      quickReplies: [
        { choice: "book", title: "One" },
        { choice: "rates", title: "Two" },
        { choice: "rooms", title: "Three" },
        { choice: "staff", title: "Four" },
      ],
    });
    expect(fake.whatsapp.messages[1]).toMatchObject({ type: "text" });
    expect(fake.whatsapp.messages[1]!.text).toContain("4. Four");

    // Template message with parameters.
    await whatsappSend(fake.urls, ACCESS_TOKEN, PHONE_NUMBER_ID, {
      mode: "template",
      to: "639171234567",
      templateName: "deposit_reminder",
      templateLanguage: "en_US",
      templateParams: ["BK-1001", "PHP 500"],
    });
    expect(fake.whatsapp.messages[2]).toMatchObject({
      type: "template",
      template: { name: "deposit_reminder", language: { code: "en_US" } },
    });

    // Delivery queue + error mapping: 131047 (24h window closed), 132001 (template unapproved), and dispatch-time stale window.
    const { userId, runId } = await makeUserAndRun();
    await saveConnection(db, KEY, userId, "whatsapp", {
      account: "+63 917 000 0999",
      credential: JSON.stringify({ accessToken: ACCESS_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN }),
      destination: { phoneNumberId: PHONE_NUMBER_ID, displayPhone: "+63 917 000 0999", webhookPath: randomBytes(32).toString("base64url") },
    });
    expect(await secretValuesToHide(db, KEY, userId)).toEqual(expect.arrayContaining([ACCESS_TOKEN, APP_SECRET, VERIFY_TOKEN]));

    const staleIso = new Date(Date.now() - 25 * 3600_000).toISOString();
    const dStaleText = await queueDelivery(db, {
      userId,
      runId,
      stepId: "wa_stale",
      provider: "whatsapp",
      reference: "W-1",
      payload: { mode: "text", to: "639171234567", text: "Late", inboundTimestamp: staleIso, receivingPhoneNumberId: PHONE_NUMBER_ID },
    });
    const dTemplateOutside = await queueDelivery(db, {
      userId,
      runId,
      stepId: "wa_tmpl",
      provider: "whatsapp",
      reference: "W-2",
      payload: { mode: "template", to: "639171234567", templateName: "deposit_reminder", templateLanguage: "en", inboundTimestamp: staleIso, receivingPhoneNumberId: PHONE_NUMBER_ID },
    });
    await runDueDeliveries(db, KEY, fake.urls);

    const [rowStale] = await db.select().from(deliveries).where(eq(deliveries.id, dStaleText.id));
    expect(rowStale).toMatchObject({ state: "failed", errorKind: "invalid" });
    expect(rowStale?.lastError).toContain("24-hour service window");

    const [rowTmpl] = await db.select().from(deliveries).where(eq(deliveries.id, dTemplateOutside.id));
    expect(rowTmpl?.state).toBe("delivered");

    fake.once(`/v21.0/${PHONE_NUMBER_ID}/messages`, {
      status: 400,
      body: { error: { code: 132001, message: "Template does not exist" } },
    });
    await expect(
      whatsappSend(fake.urls, ACCESS_TOKEN, PHONE_NUMBER_ID, { mode: "template", to: "639171234567", templateName: "unapproved" }),
    ).rejects.toMatchObject({ kind: "invalid" });

    const [conn] = await db.select().from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, "whatsapp")));
    expect(conn?.status).toBe("active");
  });
});
