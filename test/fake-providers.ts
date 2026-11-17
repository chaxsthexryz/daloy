import { createHash, createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake Google (token endpoint and Sheets API), Slack Web API, Microsoft sign-in, Microsoft Graph and Teams Workflows
 * on one local port, for tests. Nothing here talks to the real services. The Google side checks the service account's JWT signature, so a wrong key fails like it would.
 *
 * once(path, behaviour) makes the next matching call misbehave:
 * - { status, body, headers }: answer with that instead.
 * - "hang": never answer and do nothing (the call was not received).
 * - "hang-after": do the write, then never answer (the provider accepted it, the caller timed out).
 * - { late: ms }: hold the call, do the write after ms (after the caller gave up), and never answer.
 * - { heldUntil }: do the write now and answer when the promise settles; with status, write nothing and answer that then.
 *
 * Sheets developer metadata follows Google: a spreadsheets.batchUpdate is all or nothing, and creating metadata with an
 * id that already exists in the spreadsheet fails the whole batch with 400.
 */
type Behaviour = { status: number; body: unknown; headers?: Record<string, string> } | "hang" | "hang-after" | { late: number } | { heldUntil: Promise<unknown>; status?: number; body?: unknown };
type SheetMeta = { metadataId: number; metadataKey: string; metadataValue?: string; location: { sheetId: number }; visibility: string };

export type FakeProviders = Awaited<ReturnType<typeof startFakeProviders>>;

export async function startFakeProviders(port = 0) {
  const keys = new Map<string, KeyObject>(); // service account email -> public key
  const revoked = new Set<string>();
  const tokens = new Map<string, string>(); // access token -> email
  const sheets = new Map<string, { title: string; tabs: Map<string, string[][]>; editors: Set<string>; metadata: Map<number, SheetMeta> }>();
  const slack = { token: "", team: "Lim Dental", channels: [{ id: "C0REQ", name: "office-requests", is_member: true }], messages: [] as { channel: string; text: string; ts: string }[], revoked: false };
  const telegram = { token: "", bot: "daloy_test_bot", chats: [{ id: -1001234567890, title: "Office team" }] as { id: number; title: string }[], messages: [] as { chat: string; text: string; id: number }[], revoked: false };
  // Airtable, Notion and Trello (N15, decision 0044): a bearer or key/token check, one target each, and the records added.
  const airtable = { token: "", base: "appFAKEBASE000001", table: "tblFAKETABLE00001", records: [] as { id: string; fields: Record<string, unknown> }[], revoked: false };
  const notion = { token: "", database: "0123456789abcdef0123456789abcdef", title: "Office requests", titleProperty: "Name", pages: [] as { id: string; properties: Record<string, unknown> }[], revoked: false };
  const trello = { key: "", token: "", username: "daloy_tester", list: "5f0000000000000000000001", listName: "To do", cards: [] as { id: string; name: string; desc: string }[], revoked: false };
  // Microsoft: consent decides what the authorize page answers. Every refresh hands out a new refresh token; like the
  // real service, the old one keeps working until it is revoked (refreshTokens.clear()).
  const microsoft = {
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    user: { mail: "ana@contoso.example", displayName: "Ana Lim" },
    consent: "grant" as "grant" | "admin_required" | "declined",
    mailboxEnabled: true,
    codes: new Map<string, { challenge: string; redirectUri: string; scope: string }>(),
    refreshTokens: new Set<string>(),
    accessTokens: new Set<string>(),
    sent: [] as { to: string; subject: string; text: string }[],
  };
  // Google Calendar: events by calendar id then event id. Like Google, a deleted event stays as "cancelled" and its id cannot be inserted again.
  type CalendarEvent = { id: string; status: "confirmed" | "cancelled"; summary?: string; description?: string; start?: { dateTime: string; timeZone?: string }; end?: { dateTime: string; timeZone?: string } };
  const calendars = new Map<string, { title: string; editors: Set<string>; events: Map<string, CalendarEvent> }>();
  const paymongo = { sessions: [] as { id: string; amount: number }[], keys: new Map<string, unknown>() }; // keys: Idempotency-Key -> stored response
  const teams = { flows: new Set(["flow-purchasing"]), posts: [] as { flow: string; text: string }[] };
  const pending: { path: string; behaviour: Behaviour }[] = [];
  const calls: string[] = [];
  const hanging = new Set<ServerResponse>();
  let seq = 0;

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  };
  const googleError = (res: ServerResponse, code: number, status: string, message: string) => json(res, code, { error: { code, status, message } });

  async function body(req: IncomingMessage) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw;
  }

  function verifyJwt(assertion: string): string | null {
    const [h, p, s] = assertion.split(".");
    if (!h || !p || !s) return null;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as { iss: string; exp: number };
    const key = keys.get(claims.iss);
    if (!key || revoked.has(claims.iss) || claims.exp * 1000 < Date.now()) return null;
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(key, Buffer.from(s, "base64url"));
    return ok ? claims.iss : null;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = decodeURIComponent(url.pathname);
    const raw = await body(req);
    calls.push(`${req.method} ${path}`);
    const i = pending.findIndex((p) => path.includes(p.path));
    const behaviour = i >= 0 ? pending.splice(i, 1)[0]!.behaviour : undefined;
    if (behaviour === "hang") return void hanging.add(res);
    const late = typeof behaviour === "object" && "late" in behaviour;
    const held = typeof behaviour === "object" && "heldUntil" in behaviour ? behaviour : undefined;
    if (held?.status !== undefined) {
      await held.heldUntil;
      return json(res, held.status, held.body);
    }
    if (typeof behaviour === "object" && "status" in behaviour && !("heldUntil" in behaviour)) return json(res, behaviour.status, behaviour.body, behaviour.headers);
    if (late) await new Promise((r) => setTimeout(r, behaviour.late));
    const answer = (status: number, b: unknown, headers?: Record<string, string>) =>
      behaviour === "hang-after" || late ? void hanging.add(res) : held ? void held.heldUntil.then(() => json(res, status, b, headers)) : json(res, status, b, headers);

    // For the e2e suite, whose tests run in other processes: read counts, and take the Slack app out of the channel.
    if (path === "/__control") {
      if (req.method === "POST") {
        const c = JSON.parse(raw) as { slackMember?: boolean; microsoftConsent?: typeof microsoft.consent };
        if (c.slackMember !== undefined) slack.channels[0]!.is_member = c.slackMember;
        if (c.microsoftConsent) microsoft.consent = c.microsoftConsent;
      }
      return json(res, 200, {
        calendarEvents: [...calendars.values()].flatMap((c) => [...c.events.values()]),
        sheetRows: [...sheets.values()].flatMap((s) => [...s.tabs.values()].flat()).length,
        slackMessages: slack.messages.map((m) => m.text),
        outlookMessages: microsoft.sent,
        teamsPosts: teams.posts.map((p) => p.text),
        telegramMessages: telegram.messages.map((m) => m.text),
        paymongoSessions: paymongo.sessions,
        airtableRecords: airtable.records.map((r) => r.fields),
        notionPages: notion.pages.map((p) => p.properties),
        trelloCards: trello.cards.map((c) => c.name),
      });
    }

    // Microsoft identity platform v2.0, for any tenant: authorize (consents at once, or answers like a blocked
    // tenant), token (authorization code with PKCE, and refresh), and the admin consent page.
    const msPath = /^\/ms\/[^/]+\/(v2\.0\/adminconsent|oauth2\/v2\.0\/authorize|oauth2\/v2\.0\/token)$/.exec(path)?.[1];
    if (msPath === "v2.0/adminconsent") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "http://invalid");
      back.searchParams.set("admin_consent", "True");
      back.searchParams.set("tenant", "contoso");
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (msPath === "oauth2/v2.0/authorize") {
      const q = url.searchParams;
      const back = new URL(q.get("redirect_uri") ?? "http://invalid");
      back.searchParams.set("state", q.get("state") ?? "");
      if (microsoft.consent === "admin_required") {
        back.searchParams.set("error", "access_denied");
        back.searchParams.set("error_description", "AADSTS90094: The grant requires admin permission.");
      } else if (microsoft.consent === "declined") {
        back.searchParams.set("error", "access_denied");
        back.searchParams.set("error_description", "AADSTS65004: User declined to consent to access the app.");
      } else {
        const code = `code-${++seq}`;
        microsoft.codes.set(code, { challenge: q.get("code_challenge") ?? "", redirectUri: q.get("redirect_uri") ?? "", scope: q.get("scope") ?? "" });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (msPath === "oauth2/v2.0/token") {
      const form = new URLSearchParams(raw);
      const msError = (error: string, description: string) => json(res, 400, { error, error_description: description });
      if (form.get("client_id") !== microsoft.clientId || form.get("client_secret") !== microsoft.clientSecret) return msError("invalid_client", "AADSTS7000215: Invalid client secret provided.");
      if (form.get("grant_type") === "authorization_code") {
        const c = microsoft.codes.get(form.get("code") ?? "");
        microsoft.codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!c || c.redirectUri !== form.get("redirect_uri") || createHash("sha256").update(verifier).digest("base64url") !== c.challenge) {
          return msError("invalid_grant", "AADSTS70008: The provided authorization code or refresh token has expired or is invalid.");
        }
      } else if (form.get("grant_type") === "refresh_token") {
        if (!microsoft.refreshTokens.has(form.get("refresh_token") ?? "")) return msError("invalid_grant", "AADSTS50173: The provided grant has expired due to it being revoked.");
      } else return msError("unsupported_grant_type", "AADSTS70003");
      const access = `ms-access-${++seq}`;
      const refresh = `ms-refresh-${++seq}`;
      microsoft.accessTokens.add(access);
      microsoft.refreshTokens.add(refresh);
      return answer(200, { token_type: "Bearer", access_token: access, refresh_token: refresh, expires_in: 3599, scope: "Mail.Send User.Read" });
    }

    // Microsoft Graph v1.0: /me and /me/sendMail (202 with no body, like the real one).
    if (path === "/graph/v1.0/me" || path === "/graph/v1.0/me/sendMail") {
      if (!microsoft.accessTokens.has((req.headers.authorization ?? "").replace(/^Bearer /, ""))) {
        return json(res, 401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired or is not yet valid." } });
      }
      if (req.method === "GET") return json(res, 200, { displayName: microsoft.user.displayName, mail: microsoft.user.mail, userPrincipalName: microsoft.user.mail });
      if (!microsoft.mailboxEnabled) return json(res, 403, { error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." } });
      const { message } = JSON.parse(raw) as { message: { subject: string; body: { content: string }; toRecipients: { emailAddress: { address: string } }[] } };
      microsoft.sent.push({ to: message.toRecipients.map((r) => r.emailAddress.address).join(","), subject: message.subject, text: message.body.content });
      if (behaviour === "hang-after") return void hanging.add(res);
      res.writeHead(202).end();
      return;
    }

    // Teams Workflows, "When a Teams webhook request is received": 202 for a known flow, 404 once it is deleted.
    const flow = /^\/teams\/workflows\/([\w-]+)$/.exec(path)?.[1];
    if (flow) {
      if (!teams.flows.has(flow)) return json(res, 404, { error: { code: "WorkflowNotFound", message: `The workflow ${flow} could not be found.` } });
      const card = JSON.parse(raw) as { attachments?: { content?: { body?: { text?: string }[] } }[] };
      const text = card.attachments?.[0]?.content?.body?.map((b) => b.text ?? "").join("\n");
      if (!text) return json(res, 400, { error: { code: "InvalidRequestContent", message: "The request content is not valid." } });
      teams.posts.push({ flow, text });
      if (behaviour === "hang-after") return void hanging.add(res);
      res.writeHead(202).end();
      return;
    }

    // Google OAuth token endpoint (JWT bearer grant).
    if (path === "/token") {
      const form = new URLSearchParams(raw);
      const email = form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" ? verifyJwt(form.get("assertion") ?? "") : null;
      if (!email) return json(res, 400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      const token = `ya29.fake-${++seq}`;
      tokens.set(token, email);
      return json(res, 200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
    }

    // Google Calendar API v3: events list, insert (with a client-chosen id), patch and delete.
    const calPath = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (calPath) {
      const email = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!email) return googleError(res, 401, "UNAUTHENTICATED", "Invalid Credentials");
      const cal = calendars.get(calPath[1]!);
      if (!cal || !cal.editors.has(email)) return googleError(res, 404, "NOT_FOUND", "Not Found");
      const eventId = calPath[2];
      const sent = raw ? (JSON.parse(raw) as Partial<CalendarEvent>) : {};
      if (!eventId && req.method === "GET") return answer(200, { summary: cal.title, items: [...cal.events.values()].filter((e) => e.status === "confirmed") });
      if (!eventId && req.method === "POST") {
        if (!sent.id || !/^[a-v0-9]{5,1024}$/.test(sent.id)) return googleError(res, 400, "INVALID_ARGUMENT", "Invalid resource id value.");
        if (cal.events.has(sent.id)) return googleError(res, 409, "ALREADY_EXISTS", "The requested identifier already exists.");
        const event: CalendarEvent = { ...sent, id: sent.id, status: "confirmed" };
        cal.events.set(sent.id, event);
        return answer(200, event);
      }
      const event = cal.events.get(eventId ?? "");
      if (req.method === "PATCH") {
        if (!event) return googleError(res, 404, "NOT_FOUND", "Not Found");
        Object.assign(event, sent, { id: event.id });
        return answer(200, event);
      }
      if (req.method === "DELETE") {
        if (!event) return googleError(res, 404, "NOT_FOUND", "Not Found");
        if (event.status === "cancelled") return googleError(res, 410, "GONE", "Resource has been deleted");
        event.status = "cancelled";
        return answer(204, {});
      }
    }

    // Google Sheets API v4: batchUpdate (developer metadata and appendCells) and reading one metadata entry by id.
    const batchPath = /^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/.exec(path);
    const metaPath = /^\/v4\/spreadsheets\/([^/]+)\/developerMetadata\/(\d+)$/.exec(path);
    if (batchPath || metaPath) {
      const email = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!email) return googleError(res, 401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
      const sheet = sheets.get((batchPath ?? metaPath)![1]!);
      if (!sheet) return googleError(res, 404, "NOT_FOUND", "Requested entity was not found.");
      if (!sheet.editors.has(email)) return googleError(res, 403, "PERMISSION_DENIED", "The caller does not have permission");
      if (metaPath) {
        const meta = sheet.metadata.get(Number(metaPath[2]));
        return meta ? answer(200, meta) : googleError(res, 404, "NOT_FOUND", `No developer metadata with ID: ${metaPath[2]}`);
      }
      const titles = [...sheet.tabs.keys()];
      const tabOf = (sheetId: number) => titles[sheetId - 1];
      // Validate everything first, then apply: one failing request leaves the spreadsheet untouched.
      type BatchRequest = {
        createDeveloperMetadata?: { developerMetadata: SheetMeta };
        appendCells?: { sheetId: number; rows: { values: { userEnteredValue: { stringValue: string } }[] }[] };
        deleteDeveloperMetadata?: { dataFilter: { developerMetadataLookup: { metadataId?: number; metadataKey?: string; metadataValue?: string } } };
      };
      const { requests } = JSON.parse(raw) as { requests: BatchRequest[] };
      const created = new Set<number>();
      for (const r of requests) {
        const m = r.createDeveloperMetadata?.developerMetadata;
        if (m && (sheet.metadata.has(m.metadataId) || created.has(m.metadataId))) return googleError(res, 400, "INVALID_ARGUMENT", `Invalid requests[0].createDeveloperMetadata: Developer metadata with ID ${m.metadataId} already exists.`);
        if (m && !tabOf(m.location.sheetId)) return googleError(res, 400, "INVALID_ARGUMENT", "No grid with id");
        if (m) created.add(m.metadataId);
        if (r.appendCells && !tabOf(r.appendCells.sheetId)) return googleError(res, 400, "INVALID_ARGUMENT", "No grid with id");
      }
      for (const r of requests) {
        if (r.createDeveloperMetadata) sheet.metadata.set(r.createDeveloperMetadata.developerMetadata.metadataId, r.createDeveloperMetadata.developerMetadata);
        if (r.appendCells) sheet.tabs.get(tabOf(r.appendCells.sheetId)!)!.push(...r.appendCells.rows.map((row) => row.values.map((v) => v.userEnteredValue.stringValue)));
        if (r.deleteDeveloperMetadata) {
          // Like Google, a lookup matches only metadata that agrees with every field it names.
          const q = r.deleteDeveloperMetadata.dataFilter.developerMetadataLookup;
          for (const [id, m] of sheet.metadata) {
            if ((q.metadataId === undefined || q.metadataId === id) && (q.metadataKey === undefined || q.metadataKey === m.metadataKey) && (q.metadataValue === undefined || q.metadataValue === m.metadataValue)) sheet.metadata.delete(id);
          }
        }
      }
      return answer(200, { replies: requests.map(() => ({})) });
    }

    // Google Sheets API v4.
    const sheetPath = /^\/v4\/spreadsheets\/([^/]+)(?:\/values\/(.+?)(:append)?)?$/.exec(path);
    if (sheetPath) {
      const email = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!email) return googleError(res, 401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
      const sheet = sheets.get(sheetPath[1]!);
      if (!sheet) return googleError(res, 404, "NOT_FOUND", "Requested entity was not found.");
      if (!sheet.editors.has(email)) return googleError(res, 403, "PERMISSION_DENIED", "The caller does not have permission");
      if (!sheetPath[2]) return answer(200, { properties: { title: sheet.title }, sheets: [...sheet.tabs.keys()].map((title, i) => ({ properties: { title, sheetId: i + 1 } })) });
      const tabName = /^'?(.*?)'?!/.exec(sheetPath[2])?.[1]?.replaceAll("''", "'") ?? "";
      const tab = sheet.tabs.get(tabName);
      if (!tab) return googleError(res, 400, "INVALID_ARGUMENT", `Unable to parse range: ${sheetPath[2]}`);
      if (sheetPath[3]) {
        if (url.searchParams.get("valueInputOption") !== "RAW") return googleError(res, 400, "INVALID_ARGUMENT", "expected RAW");
        const { values } = JSON.parse(raw) as { values: string[][] };
        tab.push(...values);
        return answer(200, { updates: { updatedRange: `'${tabName}'!A${tab.length}:${String.fromCharCode(64 + values[0]!.length)}${tab.length}`, updatedRows: 1 } });
      }
      return answer(200, { values: tab });
    }

    // Slack Web API: always HTTP 200 with ok false and an error code, except rate limits.
    const slackMethod = /^\/api\/([a-zA-Z.]+)$/.exec(path)?.[1];
    if (slackMethod) {
      const form = new URLSearchParams(raw);
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!slack.token || token !== slack.token) return json(res, 200, { ok: false, error: "invalid_auth" });
      if (slack.revoked) return json(res, 200, { ok: false, error: "token_revoked" });
      if (slackMethod === "auth.test") return json(res, 200, { ok: true, team: slack.team, user: "daloy", team_id: "T0FAKE" });
      if (slackMethod === "conversations.list") return json(res, 200, { ok: true, channels: slack.channels });
      if (slackMethod === "chat.postMessage") {
        const channel = slack.channels.find((c) => c.id === form.get("channel"));
        if (!channel) return json(res, 200, { ok: false, error: "channel_not_found" });
        if (!channel.is_member) return json(res, 200, { ok: false, error: "not_in_channel" });
        const ts = `1700000000.${String(++seq).padStart(6, "0")}`;
        slack.messages.push({ channel: channel.id, text: form.get("text") ?? "", ts });
        return answer(200, { ok: true, channel: channel.id, ts });
      }
      return json(res, 200, { ok: false, error: "unknown_method" });
    }
    // PayMongo: Basic auth with a test secret key. A repeated Idempotency-Key gets the stored answer, not a second session.
    if (path === "/v1/checkout_sessions" || path === "/v1/webhooks") {
      const [user] = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":");
      if (!user?.startsWith("sk_test_")) return json(res, 401, { errors: [{ code: "authentication_error", detail: "Invalid authentication credentials" }] });
      if (path === "/v1/webhooks") return json(res, 200, { data: [] });
      const key = String(req.headers["idempotency-key"] ?? "");
      if (key && paymongo.keys.has(key)) return json(res, 200, paymongo.keys.get(key));
      const { line_items } = (JSON.parse(raw) as { data: { attributes: { line_items: { amount: number }[] } } }).data.attributes;
      const id = `cs_e2e_${++seq}`;
      const response = { data: { id, type: "checkout_session", attributes: { checkout_url: `https://checkout.paymongo.test/${id}`, livemode: false, status: "active", line_items } } };
      paymongo.sessions.push({ id, amount: line_items[0]!.amount });
      if (key) paymongo.keys.set(key, response);
      return answer(200, response);
    }
    // Telegram Bot API: the token is in the path, answers are { ok, result } or { ok: false, description } with a matching HTTP status.
    const tg = /^\/bot([^/]+)\/(\w+)$/.exec(path);
    if (tg) {
      const body = raw ? (JSON.parse(raw) as { chat_id?: string; text?: string }) : {};
      if (!telegram.token || tg[1] !== telegram.token || telegram.revoked) return json(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
      if (tg[2] === "getMe") return json(res, 200, { ok: true, result: { id: 123456789, is_bot: true, username: telegram.bot } });
      const chat = telegram.chats.find((c) => String(c.id) === body.chat_id);
      if (!chat) return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
      if (tg[2] === "getChat") return json(res, 200, { ok: true, result: { id: chat.id, title: chat.title, type: "group" } });
      if (tg[2] === "sendMessage") {
        const id = ++seq;
        telegram.messages.push({ chat: String(chat.id), text: body.text ?? "", id });
        return answer(200, { ok: true, result: { message_id: id, chat: { id: chat.id } } });
      }
      return json(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    }
    // Airtable: Bearer token, 401 for a bad one, 404 for another base or table. Each added record gets an id.
    const at = /^\/v0\/([^/]+)\/([^/]+)$/.exec(path);
    if (at) {
      if (!airtable.token || req.headers.authorization !== `Bearer ${airtable.token}` || airtable.revoked) return json(res, 401, { error: { type: "AUTHENTICATION_REQUIRED" } });
      if (at[1] !== airtable.base || at[2] !== airtable.table) return json(res, 404, { error: { type: "TABLE_NOT_FOUND" } });
      if (req.method === "GET") return json(res, 200, { records: airtable.records.slice(0, 1) });
      const fields = (JSON.parse(raw) as { fields?: Record<string, unknown> }).fields ?? {};
      const id = `rec${String(++seq).padStart(14, "0")}`;
      airtable.records.push({ id, fields });
      return answer(200, { id, fields, createdTime: new Date().toISOString() });
    }
    // Notion: Bearer token and a Notion-Version header. A page needs the database's title property.
    if (path.startsWith("/v1/")) {
      if (!notion.token || req.headers.authorization !== `Bearer ${notion.token}` || notion.revoked) return json(res, 401, { object: "error", code: "unauthorized" });
      if (!req.headers["notion-version"]) return json(res, 400, { object: "error", code: "missing_version" });
      if (req.method === "GET" && path === `/v1/databases/${notion.database}`) return json(res, 200, { object: "database", id: notion.database, title: [{ plain_text: notion.title }], properties: { [notion.titleProperty]: { type: "title" }, Notes: { type: "rich_text" } } });
      if (req.method === "POST" && path === "/v1/pages") {
        const page = JSON.parse(raw) as { parent?: { database_id?: string }; properties?: Record<string, { title?: unknown }> };
        if (page.parent?.database_id !== notion.database) return json(res, 404, { object: "error", code: "object_not_found" });
        if (!page.properties?.[notion.titleProperty]?.title) return json(res, 400, { object: "error", code: "validation_error" });
        const id = `page-${++seq}`;
        notion.pages.push({ id, properties: page.properties });
        return answer(200, { object: "page", id });
      }
      return json(res, 404, { object: "error", code: "object_not_found" });
    }
    // Trello: key and token in the query string. Answers are plain text on errors, like the real API.
    if (path.startsWith("/1/")) {
      const q = url.searchParams;
      if (!trello.token || q.get("key") !== trello.key || q.get("token") !== trello.token || trello.revoked) return res.writeHead(401, { "content-type": "text/plain" }).end("invalid token");
      if (path === "/1/members/me") return json(res, 200, { username: trello.username });
      if (path === `/1/lists/${trello.list}`) return json(res, 200, { id: trello.list, name: trello.listName });
      if (path === "/1/cards" && req.method === "POST") {
        const c = JSON.parse(raw) as { idList?: string; name?: string; desc?: string };
        if (c.idList !== trello.list) return res.writeHead(400, { "content-type": "text/plain" }).end("invalid value for idList");
        const id = `card${++seq}`;
        trello.cards.push({ id, name: c.name ?? "", desc: c.desc ?? "" });
        return answer(200, { id, name: c.name });
      }
      return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
    json(res, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    urls: { googleToken: `${base}/token`, sheets: base, calendar: base, paymongo: base, airtable: base, notion: base, trello: base, slack: base, telegram: base, microsoftLogin: `${base}/ms`, graph: `${base}/graph`, teamsHosts: ["127.0.0.1"] },
    calls,
    slack,
    telegram,
    airtable,
    notion,
    trello,
    microsoft,
    teams,
    teamsUrl: (flowId: string) => `${base}/teams/workflows/${flowId}`,
    /** Registers a service account key with Google. */
    addServiceAccount: (email: string, publicKeyPem: string) => {
      revoked.delete(email);
      keys.set(email, createPublicKey(publicKeyPem));
    },
    revokeServiceAccount: (email: string) => revoked.add(email),
    /** Makes every access token issued so far invalid, like an expired one. */
    expireTokens: () => tokens.clear(),
    addSheet: (id: string, title: string, tab: string, editors: string[]) => {
      const s = { title, tabs: new Map([[tab, [] as string[][]]]), editors: new Set(editors), metadata: new Map<number, SheetMeta>() };
      sheets.set(id, s);
      return s;
    },
    addCalendar: (id: string, title: string, editors: string[]) => {
      const c = { title, editors: new Set(editors), events: new Map<string, CalendarEvent>() };
      calendars.set(id, c);
      return c;
    },
    once: (path: string, behaviour: Behaviour) => pending.push({ path, behaviour }),
    async close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
