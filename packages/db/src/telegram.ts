import { createHmac } from "node:crypto";
import { FILE_MAX_BYTES, fileType, safeFileName } from "@daloy/engine";
import { z } from "zod";
import { ProviderError, telegramFileInfo, type ProviderUrls } from "./providers";

/**
 * The Telegram message trigger (T9, decision 0117). The bot token is the only stored secret: the webhook's secret_token
 * is derived from it and the random path, so a new token or a new path gives a new secret and nothing else is kept.
 */
export function telegramWebhookSecret(token: string, path: string) {
  return createHmac("sha256", token).update(`daloy telegram webhook ${path}`).digest("base64url");
}

/** The file types a message may bring in. Telegram's mime_type is only a first filter; the bytes are checked after download. */
const DOCUMENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const KEPT_KINDS = new Set(["jpeg", "png", "webp", "pdf"]);

export type TelegramFile = { fileId: string; kind: "photo" | "document"; name: string };
export type TelegramMessage = {
  updateId: number;
  chatId: string;
  chatType: string;
  fromId: string;
  fromName: string;
  username: string;
  messageId: number;
  date: string;
  text: string;
  file: TelegramFile | null;
  /** A file came with the message but is too big or not a photo or PDF. */
  fileRefused: boolean;
};

const fileId = z.string().min(1).max(200);
const size = z.number().int().nonnegative().optional();
const updateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z
    .object({
      message_id: z.number().int(),
      date: z.number().int().nonnegative(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
      from: z.object({ id: z.number().int(), first_name: z.string().optional(), last_name: z.string().optional(), username: z.string().optional() }).optional(),
      text: z.string().optional(),
      caption: z.string().optional(),
      photo: z.array(z.object({ file_id: fileId, file_size: size })).max(20).optional(),
      document: z.object({ file_id: fileId, file_name: z.string().optional(), mime_type: z.string().optional(), file_size: size }).optional(),
    })
    .optional(),
});

/** A new message from a Telegram update, or null for anything else (edits, button presses, a malformed body). */
export function parseTelegramUpdate(body: unknown, maxBytes = FILE_MAX_BYTES): TelegramMessage | null {
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success || !parsed.data.message) return null;
  const m = parsed.data.message;
  let file: TelegramFile | null = null;
  const fits = (n: number | undefined) => n === undefined || n <= maxBytes;
  if (m.photo?.length) {
    // Telegram lists the sizes of one photo from small to large. The largest that fits is the easiest for the AI step to read.
    const best = m.photo.filter((p) => fits(p.file_size)).at(-1);
    if (best) file = { fileId: best.file_id, kind: "photo", name: "telegram-photo.jpg" };
  } else if (m.document && DOCUMENT_TYPES.has(m.document.mime_type ?? "") && fits(m.document.file_size)) {
    file = { fileId: m.document.file_id, kind: "document", name: safeFileName(m.document.file_name ?? "telegram-file") || "telegram-file" };
  }
  return {
    updateId: parsed.data.update_id,
    chatId: String(m.chat.id),
    chatType: m.chat.type.slice(0, 20),
    fromId: m.from ? String(m.from.id) : "",
    fromName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ").slice(0, 100),
    username: (m.from?.username ?? "").slice(0, 64),
    messageId: m.message_id,
    date: new Date(m.date * 1000).toISOString(),
    text: (m.text ?? m.caption ?? "").slice(0, 4096),
    file,
    fileRefused: file === null && Boolean(m.photo?.length || m.document),
  };
}

/** Telegram's file paths look like photos/file_12.jpg. Anything else is not fetched. */
const SAFE_PATH = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/;

/**
 * Downloads a message's file from Telegram's file server (getFile, then GET), at most maxBytes, and keeps it only when
 * its bytes are a JPEG, PNG, WebP or PDF. null means the file is refused. A ProviderError of kind "unavailable" or
 * "quota" means try again later. Errors never include the URL, which holds the bot token.
 */
export async function downloadTelegramFile(urls: ProviderUrls, token: string, file: TelegramFile, maxBytes = FILE_MAX_BYTES) {
  let info: Awaited<ReturnType<typeof telegramFileInfo>>;
  try {
    info = await telegramFileInfo(urls, token, file.fileId);
  } catch (err) {
    if (err instanceof ProviderError && err.kind !== "unavailable" && err.kind !== "quota") return null;
    throw err;
  }
  if (!SAFE_PATH.test(info.path) || (info.size !== undefined && info.size > maxBytes)) return null;
  let res: Response;
  try {
    res = await fetch(`${urls.telegram}/file/bot${token}/${info.path}`, { redirect: "error", signal: AbortSignal.timeout(urls.timeoutMs ?? 10_000) });
  } catch {
    throw new ProviderError("Telegram's file server could not be reached. Telegram will send the message again.", "unavailable");
  }
  if (res.status === 429 || res.status >= 500) {
    await res.body?.cancel();
    throw new ProviderError(`Telegram's file server answered ${res.status}. Telegram will send the message again.`, "unavailable");
  }
  if (res.status !== 200 || !res.body || Number(res.headers.get("content-length")) > maxBytes) {
    await res.body?.cancel();
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) return null;
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    throw new ProviderError("The download from Telegram's file server broke off. Telegram will send the message again.", "unavailable");
  }
  const data = Buffer.concat(chunks);
  const type = fileType(data);
  if (!type || !KEPT_KINDS.has(type)) return null;
  return { name: file.name, type: type as "jpeg" | "png" | "webp" | "pdf", data };
}
