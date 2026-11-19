import type { Db } from "../index";
import { airtableCall, enc, notionCall, ProviderError, trelloCall, type ProviderUrls, type TrelloAuth } from "../providers";
import { withFreshToken, type HeldConnection, type OAuthProvider } from "./core";

/**
 * What Airtable, Notion and Trello share on the shared OAuth core (decision 0062): which credential a call uses, and
 * the lists the pickers show. The target of a delivery is chosen from these lists after consent, never typed.
 */

/** A consent error on the way back from these three providers: no administrator step, only a refusal or a failure. */
export const consentDeclined = (error: string): "declined" | "failed" => (error === "access_denied" ? "declined" : "failed");

type Held = HeldConnection & { authMethod: string };

/**
 * Calls fn with what the connection sends to the provider: a fresh OAuth access token, or for a pasted connection the
 * stored credential as it always was. force refreshes first (the console's Test button, so it proves the grant).
 */
export function withRecordAuth<T>(db: Db, key: Buffer, urls: ProviderUrls, workspaceId: string, def: OAuthProvider | undefined, conn: Held, fn: (credential: string) => Promise<T>, o: { force?: boolean } = {}): Promise<T> {
  if (conn.authMethod !== "oauth") return fn(conn.credential);
  // An OAuth blob must never be sent as if it were a token.
  if (!def) throw new ProviderError("This app's sign-in is not set up on this installation. Reconnect it in Apps.", "auth");
  return withFreshToken(db, key, urls, workspaceId, def, conn, fn, o);
}

/** Trello: an OAuth access token goes in a header, a pasted key and token in the query string. */
export const trelloAuthOf = (authMethod: string, credential: string): TrelloAuth => (authMethod === "oauth" ? { bearer: credential } : (JSON.parse(credential) as TrelloAuth));

export type Choice = { id: string; name: string };
/** Pages followed in a list. A workspace with more than this many bases or databases cannot pick the rest (see decision 0062). */
const MAX_PAGES = 5;
const rows = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const text = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);

// ---------------------------------------------------------------- Airtable (schema.bases:read)

/** Bases the owner can add records to (edit or create access), 1000 a page. */
export async function airtableBases(urls: ProviderUrls, token: string): Promise<Choice[]> {
  const out: Choice[] = [];
  let offset = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await airtableCall(urls, token, "GET", `meta/bases${offset ? `?offset=${enc(offset)}` : ""}`);
    for (const b of rows(body.bases)) {
      if (typeof b.id === "string" && b.id.startsWith("app") && (b.permissionLevel === "edit" || b.permissionLevel === "create")) out.push({ id: b.id, name: text(b.name, b.id) });
    }
    if (typeof body.offset !== "string" || !body.offset) break;
    offset = body.offset;
  }
  return out;
}

/** The tables of one base. Only a table id (tbl...) is offered: a name can be renamed and reused by a collaborator (security review M16). */
export async function airtableTables(urls: ProviderUrls, token: string, baseId: string): Promise<Choice[]> {
  const body = await airtableCall(urls, token, "GET", `meta/bases/${enc(baseId)}/tables`);
  return rows(body.tables).flatMap((t) => (typeof t.id === "string" && t.id.startsWith("tbl") ? [{ id: t.id, name: text(t.name, t.id) }] : []));
}

/** The connect check for an OAuth grant: the table is still in the base, read through schema.bases:read (no record read scope is asked for). */
export async function airtableSchemaCheck(urls: ProviderUrls, token: string, baseId: string, tableId: string) {
  if (!(await airtableTables(urls, token, baseId)).some((t) => t.id === tableId)) throw new ProviderError("Airtable cannot reach that table with this sign-in. Pick the table again.", "permission");
  return { baseId, tableId };
}

// ---------------------------------------------------------------- Notion (the search endpoint, API version 2022-06-28)

/** Notion's ids come with dashes from the API and without them in a link: stored without, so a pin compares the same either way. */
export const notionId = (id: string) => id.replace(/-/g, "").toLowerCase();

/** Databases the owner shared with the integration on the consent screen. Search filters to databases in the pinned API version (newer versions say data_source). */
export async function notionDatabases(urls: ProviderUrls, token: string): Promise<Choice[]> {
  const out: Choice[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await notionCall(urls, token, "POST", "search", { filter: { property: "object", value: "database" }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, false);
    for (const d of rows(body.results)) {
      if (d.object !== "database" || typeof d.id !== "string") continue;
      const title = rows(d.title).map((t) => (typeof t.plain_text === "string" ? t.plain_text : "")).join("");
      out.push({ id: notionId(d.id), name: title || "Untitled" });
    }
    if (body.has_more !== true || typeof body.next_cursor !== "string") break;
    cursor = body.next_cursor;
  }
  return out;
}

// ---------------------------------------------------------------- Trello

/** Open boards of the member, with the member's own id and name. */
export async function trelloBoards(urls: ProviderUrls, auth: TrelloAuth): Promise<Choice[]> {
  return rows(await trelloCall(urls, auth, "GET", "members/me/boards?fields=name&filter=open")).flatMap((b) => (typeof b.id === "string" ? [{ id: b.id, name: text(b.name, b.id) }] : []));
}

/** Open lists of one board. */
export async function trelloLists(urls: ProviderUrls, auth: TrelloAuth, boardId: string): Promise<Choice[]> {
  return rows(await trelloCall(urls, auth, "GET", `boards/${enc(boardId)}/lists?fields=name&filter=open`)).flatMap((l) => (typeof l.id === "string" ? [{ id: l.id, name: text(l.name, l.id) }] : []));
}

/** The identity call can answer with nothing usable. */
export const noIdentity = (what: string) => new ProviderError(`${what} did not say who signed in.`, "invalid");
