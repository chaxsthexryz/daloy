import { FILE_MAX_BYTES } from "@daloy/engine";
import { describe, expect, it } from "vitest";
import { parseTelegramUpdate, telegramWebhookSecret } from "./telegram";

const TOKEN = "123456789:AAsyntheticTelegramTokenForTests_0001"; // gitleaks:allow

const update = (message: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) => ({
  update_id: 501,
  ...(message ? { message: { message_id: 7, date: 1_763_890_000, chat: { id: 4242, type: "private" }, from: { id: 4242, first_name: "Ana", last_name: "Reyes", username: "anareyes" }, ...message } } : {}),
  ...over,
});

describe("telegramWebhookSecret", () => {
  it("is stable for one token and path, differs for another, and uses only the characters Telegram allows", () => {
    const a = telegramWebhookSecret(TOKEN, "path-one");
    expect(a).toBe(telegramWebhookSecret(TOKEN, "path-one"));
    expect(a).not.toBe(telegramWebhookSecret(TOKEN, "path-two"));
    expect(a).not.toBe(telegramWebhookSecret("123456789:AAanotherSyntheticTokenForTests_0002", "path-one"));
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
    expect(a).not.toContain(TOKEN.split(":")[1]);
  });
});

describe("parseTelegramUpdate", () => {
  it("reads a photo message: the largest size under the cap, the caption as text, and who sent it", () => {
    const m = parseTelegramUpdate(
      update({
        caption: "GCash for order 12",
        photo: [
          { file_id: "small", file_size: 1_000, width: 90, height: 90 },
          { file_id: "large", file_size: 200_000, width: 1280, height: 1280 },
          { file_id: "huge", file_size: FILE_MAX_BYTES + 1, width: 4000, height: 4000 },
        ],
      }),
    );
    expect(m).toMatchObject({ updateId: 501, chatId: "4242", chatType: "private", fromId: "4242", fromName: "Ana Reyes", username: "anareyes", messageId: 7, text: "GCash for order 12", file: { fileId: "large", kind: "photo" }, fileRefused: false });
    expect(m?.date).toBe(new Date(1_763_890_000 * 1000).toISOString());
  });

  it("takes a PDF or image document and refuses other types and files over the cap", () => {
    expect(parseTelegramUpdate(update({ document: { file_id: "d1", file_name: "receipt.pdf", mime_type: "application/pdf", file_size: 30_000 } }))?.file).toEqual({ fileId: "d1", kind: "document", name: "receipt.pdf" });
    expect(parseTelegramUpdate(update({ document: { file_id: "d2", file_name: "scan.png", mime_type: "image/png" } }))?.file).toMatchObject({ fileId: "d2" });
    for (const doc of [
      { file_id: "x1", file_name: "notes.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", file_size: 10 },
      { file_id: "x2", file_name: "run.exe", mime_type: "application/octet-stream" },
      { file_id: "x3", file_name: "big.pdf", mime_type: "application/pdf", file_size: FILE_MAX_BYTES + 1 },
    ]) {
      const m = parseTelegramUpdate(update({ document: doc }));
      expect(m?.file).toBeNull();
      expect(m?.fileRefused).toBe(true);
    }
    const allHuge = parseTelegramUpdate(update({ photo: [{ file_id: "h", file_size: FILE_MAX_BYTES + 1, width: 1, height: 1 }] }));
    expect(allHuge).toMatchObject({ file: null, fileRefused: true });
  });

  it("reads a text message with no file", () => {
    expect(parseTelegramUpdate(update({ text: "hello" }))).toMatchObject({ text: "hello", file: null, fileRefused: false });
  });

  it("ignores updates that are not a new message, and malformed bodies", () => {
    expect(parseTelegramUpdate(update(undefined, { edited_message: { message_id: 1 } }))).toBeNull();
    expect(parseTelegramUpdate(update(undefined, { callback_query: { id: "1" } }))).toBeNull();
    expect(parseTelegramUpdate({ message: { text: "no update id" } })).toBeNull();
    expect(parseTelegramUpdate(update({ chat: { id: "not a number", type: "private" } }))).toBeNull();
    expect(parseTelegramUpdate(null)).toBeNull();
    expect(parseTelegramUpdate("x")).toBeNull();
  });

  it("cuts long text and names", () => {
    const m = parseTelegramUpdate(update({ text: "a".repeat(5000), from: { id: 1, first_name: "b".repeat(300) } }));
    expect(m?.text.length).toBe(4096);
    expect(m?.fromName.length).toBe(100);
  });
});
