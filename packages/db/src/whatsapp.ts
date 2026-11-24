import { isMenuChoice, type Menu, type MenuChoice } from "@daloy/engine";
import { downloadMetaImage, MetaImageError, MetaTransientImageError, type AllowedMetaImageType, type MetaImageResolver } from "./meta";
import { call, ProviderError, providerUrls, retryAfter, type ProviderUrls, type Reply } from "./providers";

export type WhatsAppCredential = {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
};

export type WhatsAppDestination = {
  phoneNumberId: string;
  wabaId?: string;
  displayPhone?: string;
  verifiedName?: string;
  webhookPath: string;
};

export type WhatsAppIncomingMessage = {
  senderId: string;
  senderName?: string;
  messageId: string;
  text: string;
  timestamp: string;
  mediaIds: string[];
  choice?: MenuChoice;
};

export type WhatsAppSendInput =
  | { mode: "text"; to: string; text: string; quickReplies?: Menu }
  | { mode: "template"; to: string; templateName: string; templateLanguage?: string; templateParams?: string[] };

const baseOf = (urls: ProviderUrls) => urls.whatsapp ?? urls.meta ?? "https://graph.facebook.com";

/** Parses the encrypted JSON credential stored for a WhatsApp Cloud API connection (decision 0138). */
export function parseWhatsAppCredential(raw: string): WhatsAppCredential {
  try {
    const parsed = JSON.parse(raw) as Partial<WhatsAppCredential> | null;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.accessToken === "string" &&
      parsed.accessToken.trim() !== "" &&
      typeof parsed.appSecret === "string" &&
      parsed.appSecret.trim() !== "" &&
      typeof parsed.verifyToken === "string" &&
      parsed.verifyToken.trim() !== ""
    ) {
      return { accessToken: parsed.accessToken, appSecret: parsed.appSecret, verifyToken: parsed.verifyToken };
    }
  } catch {
    // malformed JSON
  }
  throw new ProviderError("Stored WhatsApp credentials could not be read. Connect WhatsApp Cloud API again.", "auth");
}

/**
 * Normalizes a WhatsApp phone number to E.164 digits without a leading '+' (what Meta wa_id and Cloud API expect).
 * Converts Philippine national format 09XXXXXXXXX or 9XXXXXXXXX to 639XXXXXXXXX; otherwise keeps 8 to 15 digits.
 */
export function normalizeWhatsAppPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (/^09\d{9}$/.test(digits)) return `63${digits.slice(1)}`;
  if (/^9\d{9}$/.test(digits)) return `63${digits}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/**
 * Extracts inbound WhatsApp Cloud API messages matching the connected phone_number_id.
 * Ignores status callbacks, echo/non-message fields, and unlinked phone numbers.
 * Interactive button/list replies and quick-reply button taps keep a fixed choice only when isMenuChoice accepts it.
 */
export function parseWhatsAppWebhook(body: unknown, dest: Partial<WhatsAppDestination> | null | undefined): WhatsAppIncomingMessage[] {
  if (!body || typeof body !== "object" || !dest?.phoneNumberId) return [];
  const obj = body as { object?: unknown; entry?: unknown };
  if (obj.object !== "whatsapp_business_account" || !Array.isArray(obj.entry)) return [];

  const expectedPhoneId = String(dest.phoneNumberId).trim();
  if (!expectedPhoneId) return [];

  const out: WhatsAppIncomingMessage[] = [];
  for (const rawEntry of obj.entry) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const changes = (rawEntry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;

    for (const rawChange of changes) {
      if (!rawChange || typeof rawChange !== "object") continue;
      const change = rawChange as { field?: unknown; value?: unknown };
      if (change.field !== "messages" || !change.value || typeof change.value !== "object") continue;
      const val = change.value as {
        metadata?: { phone_number_id?: unknown };
        contacts?: unknown;
        messages?: unknown;
      };
      if (String(val.metadata?.phone_number_id ?? "").trim() !== expectedPhoneId) continue;
      if (!Array.isArray(val.messages)) continue;

      const names = new Map<string, string>();
      if (Array.isArray(val.contacts)) {
        for (const c of val.contacts) {
          if (!c || typeof c !== "object") continue;
          const contact = c as { wa_id?: unknown; profile?: { name?: unknown } };
          const waId = typeof contact.wa_id === "string" ? contact.wa_id.trim() : "";
          const name = typeof contact.profile?.name === "string" ? contact.profile.name.trim() : "";
          if (waId && name) names.set(waId, name.slice(0, 120));
        }
      }

      for (const rawMsg of val.messages) {
        if (!rawMsg || typeof rawMsg !== "object") continue;
        const msg = rawMsg as {
          id?: unknown;
          from?: unknown;
          timestamp?: unknown;
          type?: unknown;
          text?: { body?: unknown };
          image?: { id?: unknown; caption?: unknown };
          interactive?: {
            type?: unknown;
            button_reply?: { id?: unknown; title?: unknown };
            list_reply?: { id?: unknown; title?: unknown };
          };
          button?: { payload?: unknown; text?: unknown };
        };
        const messageId = typeof msg.id === "string" ? msg.id.trim() : "";
        const rawFrom = typeof msg.from === "string" ? msg.from.trim() : "";
        const senderId = normalizeWhatsAppPhone(rawFrom) ?? rawFrom;
        if (!messageId || !senderId || senderId === expectedPhoneId) continue;

        const sec = typeof msg.timestamp === "string" || typeof msg.timestamp === "number" ? Number(msg.timestamp) : Number.NaN;
        const timestamp = Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : new Date().toISOString();

        let text: string;
        let choice: MenuChoice | undefined;
        const mediaIds: string[] = [];

        if (msg.type === "text" || (msg.type === undefined && typeof msg.text?.body === "string")) {
          text = typeof msg.text?.body === "string" ? msg.text.body : "";
        } else if (msg.type === "interactive" && msg.interactive && typeof msg.interactive === "object") {
          const picked = msg.interactive.button_reply ?? msg.interactive.list_reply;
          const id = picked?.id;
          const title = typeof picked?.title === "string" ? picked.title : "";
          text = title.slice(0, 200);
          if (isMenuChoice(id)) choice = id;
        } else if (msg.type === "button" && msg.button && typeof msg.button === "object") {
          const payload = msg.button.payload;
          const label = typeof msg.button.text === "string" ? msg.button.text : "";
          text = label.slice(0, 200);
          if (isMenuChoice(payload)) choice = payload;
        } else if (msg.type === "image" && msg.image && typeof msg.image === "object") {
          const id = typeof msg.image.id === "string" ? msg.image.id.trim() : "";
          if (id) mediaIds.push(id);
          text = typeof msg.image.caption === "string" ? msg.image.caption : "";
        } else {
          continue;
        }

        const senderName = names.get(rawFrom) ?? names.get(senderId);
        out.push({
          senderId,
          ...(senderName ? { senderName } : {}),
          messageId,
          text,
          timestamp,
          mediaIds,
          ...(choice ? { choice } : {}),
        });
      }
    }
  }
  return out;
}

function whatsappFailure(res: Reply, write: boolean): ProviderError {
  const err = (res.body.error ?? {}) as { code?: unknown; error_subcode?: unknown; message?: unknown };
  const code = Number(err.code);

  // Meta WhatsApp 24-hour customer service window closed (131047: Re-engagement message).
  if (code === 131047) {
    return new ProviderError("Past WhatsApp's 24-hour service window. Use an approved utility template message instead.", "invalid");
  }
  // Template missing, rejected, unapproved, or parameter count mismatch.
  if (code === 132000 || code === 132001 || code === 132012 || code === 132005 || code === 132015) {
    return new ProviderError("WhatsApp refused that template name, language, or parameter count. Check the approved template in Meta WhatsApp Manager.", "invalid");
  }
  if (res.status === 429 || code === 4 || code === 17 || code === 80007 || code === 130429 || code === 131056) {
    return new ProviderError("WhatsApp Cloud API is limiting requests right now. kymavo will try again.", "quota", retryAfter(res.headers));
  }
  if (res.status >= 500) {
    return new ProviderError(`WhatsApp Cloud API answered ${res.status}.`, write ? "ambiguous" : "unavailable");
  }
  if (res.status === 401 || res.status === 403 || code === 190) {
    return new ProviderError("Meta no longer accepts the WhatsApp access token. Reconnect WhatsApp Cloud API in Apps.", "auth");
  }
  return new ProviderError("WhatsApp Cloud API refused the message. Check the Phone Number ID, recipient number, and Meta Business payment status.", "invalid");
}

/** Validates the WhatsApp system-user token and Phone Number ID via Graph API GET /v21.0/:phoneNumberId. */
export async function whatsappIdentity(
  urls: ProviderUrls = providerUrls(),
  accessToken: string,
  phoneNumberId: string,
): Promise<{ id: string; displayPhone?: string; verifiedName?: string }> {
  const res = await call(
    `${baseOf(urls)}/v21.0/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name`,
    { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } },
    urls.timeoutMs ?? 10_000,
    false,
    "WhatsApp",
  );
  if (res.status !== 200) throw whatsappFailure(res, false);
  const id = String(res.body.id ?? "").trim();
  if (!id) throw new ProviderError("Meta did not return a WhatsApp Phone Number ID for that token.", "auth");
  const displayPhone = typeof res.body.display_phone_number === "string" ? res.body.display_phone_number.trim() : undefined;
  const verifiedName = typeof res.body.verified_name === "string" ? res.body.verified_name.trim() : undefined;
  return { id, ...(displayPhone ? { displayPhone } : {}), ...(verifiedName ? { verifiedName } : {}) };
}

/**
 * Looks up a WhatsApp media object ID to retrieve its temporary CDN URL, then downloads it through
 * Meta's SSRF-protected image pipeline with Bearer auth sent strictly to allowlisted CDN hosts.
 */
export async function downloadWhatsAppMedia(
  urls: ProviderUrls,
  accessToken: string,
  mediaId: string,
  opts: { resolve?: MetaImageResolver; timeoutMs?: number; maxBytes?: number; index?: number } = {},
): Promise<{ name: string; type: AllowedMetaImageType; data: Buffer }> {
  const res = await call(
    `${baseOf(urls)}/v21.0/${encodeURIComponent(mediaId)}`,
    { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } },
    opts.timeoutMs ?? urls.timeoutMs ?? 10_000,
    false,
    "WhatsApp media",
  );
  if (res.status === 429 || res.status >= 500) {
    throw new MetaTransientImageError(`WhatsApp media lookup answered HTTP ${res.status}.`);
  }
  if (res.status !== 200 || typeof res.body.url !== "string" || !res.body.url.trim()) {
    throw new MetaImageError("Could not look up WhatsApp image download URL.");
  }
  return downloadMetaImage(res.body.url.trim(), {
    urls,
    ...opts,
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function buildTextWithMenu(text: string, quickReplies?: Menu) {
  if (!quickReplies || quickReplies.length === 0) {
    return { type: "text" as const, text: { preview_url: false, body: text } };
  }
  // WhatsApp interactive button messages support at most 3 reply buttons cleanly across clients.
  if (quickReplies.length <= 3) {
    return {
      type: "interactive" as const,
      interactive: {
        type: "button" as const,
        body: { text: text.slice(0, 1024) },
        action: {
          buttons: quickReplies.map((q) => ({
            type: "reply" as const,
            reply: { id: q.choice, title: q.title.slice(0, 20) },
          })),
        },
      },
    };
  }
  const lines = quickReplies.map((q, i) => `${i + 1}. ${q.title}`).join("\n");
  return { type: "text" as const, text: { preview_url: false, body: `${text}\n\n${lines}`.slice(0, 4096) } };
}

/** Sends a WhatsApp Cloud API service message (inside 24h window) or approved utility/marketing template (anytime). */
export async function whatsappSend(
  urls: ProviderUrls = providerUrls(),
  accessToken: string,
  phoneNumberId: string,
  msg: WhatsAppSendInput,
): Promise<{ recipientId: string; messageId: string }> {
  const payload =
    msg.mode === "template"
      ? {
          messaging_product: "whatsapp",
          to: msg.to,
          type: "template",
          template: {
            name: msg.templateName,
            language: { code: msg.templateLanguage ?? "en" },
            ...(msg.templateParams?.length
              ? {
                  components: [
                    {
                      type: "body",
                      parameters: msg.templateParams.map((text) => ({ type: "text", text })),
                    },
                  ],
                }
              : {}),
          },
        }
      : {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: msg.to,
          ...buildTextWithMenu(msg.text, msg.quickReplies),
        };

  const res = await call(
    `${baseOf(urls)}/v21.0/${encodeURIComponent(phoneNumberId)}/messages`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    },
    urls.timeoutMs ?? 10_000,
    true,
    "WhatsApp",
  );
  if (res.status !== 200) throw whatsappFailure(res, true);
  const messages = Array.isArray(res.body.messages) ? (res.body.messages as { id?: unknown }[]) : [];
  const messageId = typeof messages[0]?.id === "string" ? messages[0].id.trim() : "";
  if (!messageId) {
    throw new ProviderError("WhatsApp returned an unexpected response without a message ID, so kymavo cannot tell whether the message went through.", "ambiguous");
  }
  const contacts = Array.isArray(res.body.contacts) ? (res.body.contacts as { wa_id?: unknown }[]) : [];
  const recipientId = typeof contacts[0]?.wa_id === "string" ? contacts[0].wa_id : msg.to;
  return { recipientId, messageId };
}
