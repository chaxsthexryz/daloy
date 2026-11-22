/**
 * Pure rules for the Discord and Google Docs steps (phase I1, decision 0104). Kept apart from the providers so the editor,
 * the worker and the tests share one reading of "a valid message" and "a valid placeholder".
 */

/** Discord refuses a webhook message with more than 2000 characters. */
export const DISCORD_MAX_CHARS = 2000;

export type ContentCheck = { ok: true; value: string } | { ok: false; error: string };

/** The message Discord will get: trimmed, not empty, at most 2000 characters (an emoji counts as one). */
export function checkDiscordContent(text: string): ContentCheck {
  const value = text.trim();
  if (!value) return { ok: false, error: "The Discord message is empty." };
  const length = [...value].length;
  if (length > DISCORD_MAX_CHARS) return { ok: false, error: `The Discord message is ${length} characters, above the ${DISCORD_MAX_CHARS}-character limit.` };
  return { ok: true, value };
}

/** A placeholder name as written between the braces in the document: letters, digits, spaces and _ - . only. */
const PLACEHOLDER_KEY = /^[\p{L}\p{N}_.-](?:[\p{L}\p{N}_. -]{0,38}[\p{L}\p{N}_.-])?$/u;
export const isPlaceholderKey = (key: string): boolean => PLACEHOLDER_KEY.test(key);

export const DOCS_MAX_VALUES = 50;

/**
 * Google Docs batchUpdate requests: each {{key}} in the copy becomes its value. The match is exact and case sensitive.
 * Docs applies the requests of one batch in order, so a value that contains {{other}} would be replaced again by the
 * later request for "other". To stop that, every {{key}} first becomes an opaque token (with a random nonce, so a
 * visitor cannot type one), and only then does each token become its value. A value is inserted as plain text and is
 * never read again. One batchUpdate is all or nothing, so a retry after a failure starts from the untouched copy.
 */
export function docsReplaceRequests(values: Record<string, string>, nonce: string = globalThis.crypto.randomUUID()) {
  const entries = Object.entries(values);
  const token = (i: number) => `⟦${nonce}:${i}⟧`;
  const replace = (text: string, replaceText: string) => ({ replaceAllText: { containsText: { text, matchCase: true }, replaceText } });
  return [...entries.map(([key], i) => replace(`{{${key}}}`, token(i))), ...entries.map(([, value], i) => replace(token(i), value))];
}

const DOC_ID = /^[\w-]{10,100}$/;
/** Whether this looks like a Google file id, as Drive returns it. */
export const isGoogleFileId = (id: string): boolean => DOC_ID.test(id);

/** The link to a document, built from its id and nothing Google sent back. */
export function googleDocUrl(id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error("Not a Google document id.");
  return `https://docs.google.com/document/d/${id}/edit`;
}
