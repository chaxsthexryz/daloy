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
 * once(path, behaviour, skip) lets the first `skip` matching calls through, so a test can fail only the second file of a Drive save.
 *
 * Drive: a folder is in a shared drive (sharedDriveId) or not. Like Google, a service account cannot own files, so an upload to a folder with no shared drive fails with 403 storageQuotaExceeded.
 *
 * Google OAuth (decision 0060): add the app with addOAuthApp("google"). Its access tokens work on the Sheets and Drive
 * fakes as that user, with drive.file rules: a file the user did not pick (is not an editor of) answers 404, and an
 * upload may go to My Drive. Creating a spreadsheet or folder makes the user its editor, like a file the app created.
 *
 * Sheets developer metadata follows Google: a spreadsheets.batchUpdate is all or nothing, and creating metadata with an
 * id that already exists in the spreadsheet fails the whole batch with 400.
 */
/**
 * A generic OAuth 2.0 app at /oauth/<name>/{authorize,token,revoke,userinfo}, for the shared OAuth core (decision 0058).
 * Later phases add an app with oauthApp("<name>", { ...overrides }) in the `oauth` list below and point their provider
 * definition at fake.oauthUrls("<name>"). The fields are the knobs a test turns:
 * - consent: what the authorize page answers. "narrow" grants only grantScopes.
 * - rotation: "none" keeps the refresh token, "rotate" hands out a new one and keeps the old working, "strict" hands out
 *   a new one and refuses the old (reuse), unless keepPrevious lets the previous one through once more.
 * - expiresIn: access token lifetime in seconds (undefined: never expires). refresh: whether refresh tokens exist.
 * 429, 5xx and slow answers come from once("/oauth/<name>/token", ...), like every other fake endpoint.
 */
function oauthApp(name: string, o: { expiresIn?: number; rotation?: "none" | "rotate" | "strict"; refresh?: boolean; clientAuth?: "basic"; bodyFormat?: "json"; requirePkce?: boolean } = {}) {
  return {
    name,
    /** What the token endpoint insists on, like the real ones: client credentials in a Basic header, a JSON body, a PKCE challenge at consent. */
    clientAuth: o.clientAuth,
    bodyFormat: o.bodyFormat,
    requirePkce: o.requirePkce ?? false,
    /** How each token and revoke call arrived, without any secret: for assertions about the wire format. */
    seen: [] as { endpoint: string; basic: boolean; json: boolean; fields: string[]; notionVersion: boolean }[],
    clientId: `${name}-client-id`,
    clientSecret: `${name}-client-secret`,
    user: { id: `${name}-user-1`, email: `ana@${name}.example` },
    /** userinfo's email_verified (Gmail refuses an address Google did not verify). */
    emailVerified: true,
    consent: "grant" as "grant" | "declined" | "admin_required" | "narrow",
    grantScopes: [] as string[],
    rotation: o.rotation ?? "strict",
    keepPrevious: false,
    expiresIn: "expiresIn" in o ? o.expiresIn : 3600,
    refresh: o.refresh ?? true,
    revokeStatus: 200,
    codes: new Map<string, { challenge: string; redirectUri: string; scope: string; user: { id: string; email: string } }>(),
    refreshTokens: new Map<string, { scope: string; user: { id: string; email: string } }>(),
    previous: new Map<string, { scope: string; user: { id: string; email: string } }>(),
    accessTokens: new Map<string, { id: string; email: string }>(),
    revoked: [] as string[],
    tokenCalls: 0,
  };
}

type Behaviour = { status: number; body: unknown; headers?: Record<string, string> } | "hang" | "hang-after" | { late: number } | { heldUntil: Promise<unknown>; status?: number; body?: unknown };
type SheetMeta = { metadataId: number; metadataKey: string; metadataValue?: string; location: { sheetId: number }; visibility: string };

export type FakeProviders = Awaited<ReturnType<typeof startFakeProviders>>;

export async function startFakeProviders(port = 0) {
  const keys = new Map<string, KeyObject>(); // service account email -> public key
  const revoked = new Set<string>();
  const tokens = new Map<string, string>(); // access token -> email
  const sheets = new Map<string, { title: string; tabs: Map<string, string[][]>; editors: Set<string>; metadata: Map<number, SheetMeta> }>();
  const slack = { token: "", team: "Lim Dental", channels: [{ id: "C0REQ", name: "office-requests", is_member: true }], messages: [] as { channel: string; text: string; ts: string }[], revoked: false, installs: new Map<string, { teamId: string; team: string }>(), revokedInstalls: [] as string[] };
  const telegram = { token: "", bot: "daloy_test_bot", chats: [{ id: -1001234567890, title: "Office team" }] as { id: number; title: string }[], messages: [] as { chat: string; text: string; id: number }[], revoked: false };
  // Airtable, Notion and Trello (N15, decision 0046): a bearer or key/token check, one target each, and the records added.
  // The OAuth pickers (decision 0062) list what is here: bases and tables for Airtable, databases for Notion, boards and lists for Trello.
  const airtable = {
    token: "",
    base: "appFAKEBASE000001",
    table: "tblFAKETABLE00001",
    records: [] as { id: string; fields: Record<string, unknown> }[],
    revoked: false,
    bases: [
      { id: "appFAKEBASE000001", name: "Office", permissionLevel: "create", tables: [{ id: "tblFAKETABLE00001", name: "Requests" }, { id: "tblFAKETABLE00002", name: "Archive" }] },
      { id: "appFAKEBASE000002", name: "Read only base", permissionLevel: "read", tables: [{ id: "tblFAKETABLE00003", name: "Secrets" }] },
      { id: "appFAKEBASE000003", name: "Second base", permissionLevel: "edit", tables: [{ id: "tblFAKETABLE00004", name: "Leads" }] },
    ],
  };
  const notion = {
    token: "",
    database: "0123456789abcdef0123456789abcdef",
    title: "Office requests",
    titleProperty: "Name",
    pages: [] as { id: string; properties: Record<string, unknown> }[],
    revoked: false,
    more: [{ id: "fedcba9876543210fedcba9876543210", title: "Leads", titleProperty: "Lead name" }],
    workspace: "Lim Dental Workspace",
  };
  const trello = {
    key: "",
    token: "",
    username: "daloy_tester",
    list: "5f0000000000000000000001",
    listName: "To do",
    cards: [] as { id: string; name: string; desc: string }[],
    revoked: false,
    boards: [
      { id: "5f0000000000000000000010", name: "Office", lists: [{ id: "5f0000000000000000000001", name: "To do", closed: false }, { id: "5f0000000000000000000002", name: "Doing", closed: false }, { id: "5f0000000000000000000004", name: "Old list", closed: true }] },
      { id: "5f0000000000000000000011", name: "Home", lists: [{ id: "5f0000000000000000000003", name: "Chores", closed: false }] },
    ],
  };
  // Microsoft: consent decides what the authorize page answers. Every refresh hands out a new refresh token; like the
  // real service, the old one keeps working until it is revoked (refreshTokens.clear()).
  const microsoft = {
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    user: { id: "ms-user-ana", mail: "ana@contoso.example", displayName: "Ana Lim" },
    consent: "grant" as "grant" | "admin_required" | "declined",
    mailboxEnabled: true,
    codes: new Map<string, { challenge: string; redirectUri: string; scope: string }>(),
    refreshTokens: new Set<string>(),
    accessTokens: new Set<string>(),
    sent: [] as { to: string; subject: string; text: string }[],
  };
  // Google Calendar: events by calendar id then event id. Like Google, a deleted event stays as "cancelled" and its id cannot be inserted again.
  type CalendarEvent = { id: string; status: "confirmed" | "cancelled"; summary?: string; description?: string; start?: { dateTime: string; timeZone?: string }; end?: { dateTime: string; timeZone?: string } };
  // createdBy is the Google sign-in that made the calendar through calendars.insert: with calendar.app.created (decision 0064) that is the only kind a sign-in may use.
  const calendars = new Map<string, { title: string; editors: Set<string>; events: Map<string, CalendarEvent>; createdBy?: string }>();
  // Google Drive: folders by id, and the files saved into them (bytes are kept as a hash, not stored).
  const driveFolders = new Map<string, { name: string; editors: Set<string>; sharedDriveId: string | null }>();
  const driveFiles: { id: string; name: string; parent: string; mimeType: string; size: number; sha256: string }[] = [];
  const paymongo = { sessions: [] as { id: string; amount: number }[], keys: new Map<string, unknown>() }; // keys: Idempotency-Key -> stored response
  const teams = { flows: new Set(["flow-purchasing"]), posts: [] as { flow: string; text: string }[] };
  // Gmail API (decision 0063): messages sent with a Google OAuth access token, as the RFC 822 text Google received.
  const gmail = { sent: [] as { id: string; user: string; raw: string }[] };
  // "v2" is Slack's "Connect Slack" install (/oauth/v2/authorize, and /api/oauth.v2.access below): bot tokens that never expire.
  // Its user stands for the installing workspace: id is the team id and email the team name.
  // The record apps' consent and token endpoints, as the real ones want them (decision 0062).
  const oauth: Record<string, ReturnType<typeof oauthApp>> = {
    test: oauthApp("test"),
    v2: oauthApp("v2", { refresh: false, expiresIn: undefined }),
    airtable: oauthApp("airtable", { clientAuth: "basic", requirePkce: true }),
    notion: oauthApp("notion", { clientAuth: "basic", bodyFormat: "json" }),
    trello: oauthApp("trello", { bodyFormat: "json", requirePkce: true }),
  };
  oauth.v2!.user = { id: "T0INSTALL1", email: "Acme Dental" };
  const bearerOf = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer /, "");
  /** Who an OAuth access token issued by a record app belongs to; undefined for anything else. */
  const oauthWho = (name: string, req: IncomingMessage) => oauth[name]?.accessTokens.get(bearerOf(req));
  const dashed = (id: string) => id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  const pending: { path: string; behaviour: Behaviour; skip: number }[] = [];
  const calls: string[] = [];
  const hanging = new Set<ServerResponse>();
  let seq = 0;

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  };
  const googleError = (res: ServerResponse, code: number, status: string, message: string) => json(res, code, { error: { code, status, message } });
  /** Who a Google bearer token belongs to: a service account, or a user of the Google OAuth app (drive.file). */
  const googleCaller = (req: IncomingMessage) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const sa = tokens.get(token);
    if (sa) return { email: sa, oauth: false };
    const user = oauth.google?.accessTokens.get(token);
    return user ? { email: user.email, oauth: true } : null;
  };

  async function body(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
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
    const bytes = await body(req);
    const raw = bytes.toString("utf8");
    calls.push(`${req.method} ${path}`);
    const i = pending.findIndex((p) => path.includes(p.path) && (p.skip > 0 ? (p.skip--, false) : true));
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
        const c = JSON.parse(raw) as { slackMember?: boolean; slackConsent?: "grant" | "declined"; microsoftConsent?: typeof microsoft.consent };
        if (c.slackMember !== undefined) slack.channels[0]!.is_member = c.slackMember;
        if (c.slackConsent) oauth.v2!.consent = c.slackConsent;
        if (c.microsoftConsent) microsoft.consent = c.microsoftConsent;
      }
      return json(res, 200, {
        driveFiles,
        calendarEvents: [...calendars.values()].flatMap((c) => [...c.events.values()]),
        sheetRows: [...sheets.values()].flatMap((s) => [...s.tabs.values()].flat()).length,
        slackMessages: slack.messages.map((m) => m.text),
        slackInstalls: slack.installs.size,
        slackRevokedInstalls: slack.revokedInstalls.length,
        outlookMessages: microsoft.sent,
        teamsPosts: teams.posts.map((p) => p.text),
        telegramMessages: telegram.messages.map((m) => m.text),
        paymongoSessions: paymongo.sessions,
        airtableRecords: airtable.records.map((r) => r.fields),
        notionPages: notion.pages.map((p) => p.properties),
        trelloCards: trello.cards.map((c) => c.name),
        gmailMessages: gmail.sent,
      });
    }

    // Generic OAuth apps (see oauthApp above).
    // The record apps answer at the real providers' own paths (decision 0062).
    const real = [/^\/(airtable)-login\/oauth2\/v1\/(authorize|token)$/, /^\/(atlassian)\/(authorize|oauth\/token)$/].map((re) => re.exec(path)).find(Boolean);
    const notionOauth = /^\/v1\/oauth\/(authorize|token|revoke)$/.exec(path);
    const oa = real ? [path, real[1] === "atlassian" ? "trello" : real[1], real[2] === "oauth/token" ? "token" : real[2]] : notionOauth ? [path, "notion", notionOauth[1]] : /^\/oauth\/([\w-]+)\/(authorize|token|revoke|userinfo)$/.exec(path);
    const app = oa && oauth[oa[1]!];
    if (oa && app) {
      const endpoint = oa[2];
      if (endpoint === "authorize") {
        const q = url.searchParams;
        const back = new URL(q.get("redirect_uri") ?? "http://invalid");
        back.searchParams.set("state", q.get("state") ?? "");
        if (q.get("client_id") !== app.clientId) back.searchParams.set("error", "invalid_client");
        else if (app.requirePkce && (!q.get("code_challenge") || q.get("code_challenge_method") !== "S256")) back.searchParams.set("error", "invalid_request");
        else if (app.consent === "declined") back.searchParams.set("error", "access_denied");
        else if (app.consent === "admin_required") {
          back.searchParams.set("error", "access_denied");
          back.searchParams.set("error_description", "admin approval required");
        } else {
          const code = `${app.name}-code-${++seq}`;
          const scope = app.consent === "narrow" ? app.grantScopes.join(" ") : (q.get("scope") ?? "");
          app.codes.set(code, { challenge: q.get("code_challenge") ?? "", redirectUri: q.get("redirect_uri") ?? "", scope, user: { ...app.user } });
          back.searchParams.set("code", code);
        }
        res.writeHead(302, { location: back.toString() }).end();
        return;
      }
      const isJson = (req.headers["content-type"] ?? "").includes("json");
      const form = new URLSearchParams(isJson ? Object.entries(JSON.parse(raw || "{}") as Record<string, unknown>).map(([k, v]) => [k, String(v)]) : raw);
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
      const [basicId, basicSecret] = basic ? Buffer.from(basic[1]!, "base64").toString().split(":") : [];
      if (endpoint !== "userinfo" && endpoint !== "authorize") app.seen.push({ endpoint: String(endpoint), basic: !!basic, json: isJson, fields: [...form.keys()], notionVersion: !!req.headers["notion-version"] });
      if (endpoint === "userinfo") {
        const who = app.accessTokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
        return who ? json(res, 200, { sub: who.id, email: who.email, email_verified: app.emailVerified }) : json(res, 401, { error: "invalid_token" });
      }
      if (app.bodyFormat === "json" && !isJson) return json(res, 400, { error: "invalid_request" });
      if (app.clientAuth === "basic" && !basic) return json(res, 401, { error: "invalid_client" });
      if ((basic ? basicId : form.get("client_id")) !== app.clientId || (basic ? basicSecret : form.get("client_secret")) !== app.clientSecret) return json(res, 401, { error: "invalid_client" });
      if (endpoint === "revoke") {
        const token = form.get("token") ?? "";
        app.revoked.push(token);
        if (app.revokeStatus !== 200) return json(res, app.revokeStatus, { error: "server_error" });
        if (app.name === "notion" && !app.accessTokens.has(token)) return json(res, 400, { error: "invalid_request" });
        app.refreshTokens.delete(token);
        app.accessTokens.delete(token);
        return json(res, 200, {});
      }
      app.tokenCalls++;
      const invalidGrant = () => json(res, 400, { error: "invalid_grant", error_description: "The grant is invalid, expired, revoked or was used before." });
      let grant: { scope: string; user: { id: string; email: string } };
      let refreshToken: string | undefined;
      if (form.get("grant_type") === "authorization_code") {
        const c = app.codes.get(form.get("code") ?? "");
        app.codes.delete(form.get("code") ?? "");
        if (app.requirePkce && !form.get("code_verifier")) return invalidGrant();
        const pkceOk = !c?.challenge || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === c.challenge;
        if (!c || c.redirectUri !== form.get("redirect_uri") || !pkceOk) return invalidGrant();
        grant = c;
        if (app.refresh) refreshToken = `${app.name}-refresh-${++seq}`;
      } else if (form.get("grant_type") === "refresh_token") {
        const old = form.get("refresh_token") ?? "";
        const live = app.refreshTokens.get(old) ?? (app.keepPrevious ? app.previous.get(old) : undefined);
        if (!live) return invalidGrant();
        grant = live;
        if (app.rotation !== "none") {
          refreshToken = `${app.name}-refresh-${++seq}`;
          if (app.rotation === "strict") {
            app.refreshTokens.delete(old);
            app.previous.clear();
            if (app.keepPrevious) app.previous.set(old, live);
          }
        }
      } else return json(res, 400, { error: "unsupported_grant_type" });
      const access = `${app.name}-access-${++seq}`;
      app.accessTokens.set(access, grant.user);
      if (refreshToken) app.refreshTokens.set(refreshToken, grant);
      return answer(200, { token_type: "Bearer", access_token: access, ...(refreshToken ? { refresh_token: refreshToken } : {}), ...(app.expiresIn === undefined ? {} : { expires_in: app.expiresIn }), scope: grant.scope });
    }

    // Gmail API users.messages.send: a Google OAuth app's access token and the message as base64url.
    if (path === "/gmail/v1/users/me/messages/send" && req.method === "POST") {
      const user = oauth.google?.accessTokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!user) return googleError(res, 401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
      const message = (JSON.parse(raw) as { raw?: string }).raw;
      if (!message) return googleError(res, 400, "INVALID_ARGUMENT", "Recipient address required");
      const id = `gmail-${++seq}`;
      gmail.sent.push({ id, user: user.email, raw: Buffer.from(message, "base64url").toString("utf8") });
      return answer(200, { id, threadId: id, labelIds: ["SENT"] });
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
      if (req.method === "GET") return json(res, 200, { id: microsoft.user.id, displayName: microsoft.user.displayName, mail: microsoft.user.mail, userPrincipalName: microsoft.user.mail });
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

    // Google Drive API v3: read a folder, and multipart/related upload into one.
    const driveGet = /^\/drive\/v3\/files\/([^/]+)$/.exec(path)?.[1];
    if (driveGet || path === "/upload/drive/v3/files" || (path === "/drive/v3/files" && req.method === "POST")) {
      const caller = googleCaller(req);
      if (!caller) return googleError(res, 401, "UNAUTHENTICATED", "Invalid Credentials");
      const email = caller.email;
      if (path === "/drive/v3/files") {
        const meta = JSON.parse(raw) as { name?: string; mimeType?: string };
        if (meta.mimeType !== "application/vnd.google-apps.folder") return googleError(res, 400, "INVALID_ARGUMENT", "Only folders here.");
        const id = `drivefolder${String(++seq).padStart(8, "0")}`;
        driveFolders.set(id, { name: meta.name ?? "Untitled folder", editors: new Set([email]), sharedDriveId: null });
        return answer(200, { id, name: meta.name });
      }
      const driveError = (code: number, reason: string, message: string) => json(res, code, { error: { code, message, errors: [{ reason, message }] } });
      if (driveGet) {
        const f = driveFolders.get(driveGet);
        if (!f || !f.editors.has(email)) return googleError(res, 404, "NOT_FOUND", `File not found: ${driveGet}.`);
        return answer(200, { id: driveGet, name: f.name, mimeType: "application/vnd.google-apps.folder", ...(f.sharedDriveId ? { driveId: f.sharedDriveId } : {}), capabilities: { canAddChildren: true } });
      }
      const boundary = /boundary=([^;]+)/.exec(String(req.headers["content-type"] ?? ""))?.[1];
      if (!boundary || url.searchParams.get("uploadType") !== "multipart") return googleError(res, 400, "INVALID_ARGUMENT", "Bad multipart request.");
      const delim = Buffer.from(`--${boundary}`);
      const crlf2 = Buffer.from("\r\n\r\n");
      const start1 = bytes.indexOf(delim);
      const head1 = bytes.indexOf(crlf2, start1);
      const next = bytes.indexOf(Buffer.from(`\r\n--${boundary}`), head1);
      const head2 = bytes.indexOf(crlf2, next);
      const end = bytes.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      if (start1 < 0 || head1 < 0 || next < 0 || head2 < 0 || end < head2) return googleError(res, 400, "INVALID_ARGUMENT", "Bad multipart request.");
      const meta = JSON.parse(bytes.subarray(head1 + 4, next).toString("utf8")) as { name?: string; parents?: string[]; mimeType?: string };
      const data = bytes.subarray(head2 + 4, end);
      const folder = driveFolders.get(meta.parents?.[0] ?? "");
      if (!folder || !folder.editors.has(email)) return googleError(res, 404, "NOT_FOUND", "File not found.");
      if (!folder.sharedDriveId && !caller.oauth) return driveError(403, "storageQuotaExceeded", "Service Accounts do not have storage quota. Leverage shared drives instead.");
      const id = `drivefile${String(++seq).padStart(8, "0")}`;
      driveFiles.push({ id, name: meta.name ?? "", parent: meta.parents![0]!, mimeType: meta.mimeType ?? "", size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
      return answer(200, { id, name: meta.name });
    }

    // Google Calendar API v3: events list, insert (with a client-chosen id), patch and delete.
    // calendars.insert: a Google sign-in makes a calendar it may then use (calendar.app.created).
    if (path === "/calendar/v3/calendars" && req.method === "POST") {
      const caller = googleCaller(req);
      if (!caller?.oauth) return googleError(res, caller ? 403 : 401, caller ? "PERMISSION_DENIED" : "UNAUTHENTICATED", "Only a Google sign-in makes calendars here.");
      const id = `daloycal${String(++seq).padStart(6, "0")}@group.calendar.google.com`;
      const title = (JSON.parse(raw || "{}") as { summary?: string }).summary ?? "";
      calendars.set(id, { title, editors: new Set([caller.email]), events: new Map(), createdBy: caller.email });
      return answer(200, { id, summary: title });
    }
    const calPath = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (calPath) {
      const caller = googleCaller(req);
      if (!caller) return googleError(res, 401, "UNAUTHENTICATED", "Invalid Credentials");
      const email = caller.email;
      const cal = calendars.get(calPath[1]!);
      if (!cal || !cal.editors.has(email) || (caller.oauth && cal.createdBy !== email)) return googleError(res, 404, "NOT_FOUND", "Not Found");
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
      const caller = googleCaller(req);
      if (!caller) return googleError(res, 401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
      const sheet = sheets.get((batchPath ?? metaPath)![1]!);
      if (!sheet || (caller.oauth && !sheet.editors.has(caller.email))) return googleError(res, 404, "NOT_FOUND", "Requested entity was not found.");
      if (!sheet.editors.has(caller.email)) return googleError(res, 403, "PERMISSION_DENIED", "The caller does not have permission");
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
    // spreadsheets.create: a new spreadsheet with one tab, owned by the caller.
    if (path === "/v4/spreadsheets" && req.method === "POST") {
      const caller = googleCaller(req);
      if (!caller) return googleError(res, 401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
      const title = (JSON.parse(raw) as { properties?: { title?: string } }).properties?.title ?? "Untitled spreadsheet";
      const id = `created-sheet-${String(++seq).padStart(8, "0")}`;
      sheets.set(id, { title, tabs: new Map([["Sheet1", [] as string[][]]]), editors: new Set([caller.email]), metadata: new Map<number, SheetMeta>() });
      return answer(200, { spreadsheetId: id, properties: { title }, sheets: [{ properties: { sheetId: 1, title: "Sheet1" } }] });
    }

    const sheetPath = /^\/v4\/spreadsheets\/([^/]+)(?:\/values\/(.+?)(:append)?)?$/.exec(path);
    if (sheetPath) {
      const caller = googleCaller(req);
      if (!caller) return googleError(res, 401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
      const sheet = sheets.get(sheetPath[1]!);
      if (!sheet || (caller.oauth && !sheet.editors.has(caller.email))) return googleError(res, 404, "NOT_FOUND", "Requested entity was not found.");
      if (!sheet.editors.has(caller.email)) return googleError(res, 403, "PERMISSION_DENIED", "The caller does not have permission");
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
    const slackMethod = /^\/api\/([\w.]+)$/.exec(path)?.[1];
    if (slackMethod === "oauth.v2.access") {
      // The install's code exchange: HTTP 200 with ok false for a bad code or client, a "bot" token otherwise (see the "v2" app).
      const app = oauth.v2!;
      const form = new URLSearchParams(raw);
      app.tokenCalls++;
      const c = app.codes.get(form.get("code") ?? "");
      app.codes.delete(form.get("code") ?? "");
      if (form.get("client_id") !== app.clientId || form.get("client_secret") !== app.clientSecret) return json(res, 200, { ok: false, error: "invalid_client_id" });
      if (!c || c.redirectUri !== form.get("redirect_uri")) return json(res, 200, { ok: false, error: "invalid_code" });
      const access = `xoxb-fake-install-${++seq}-${seq}abcdef`;
      slack.installs.set(access, { teamId: c.user.id, team: c.user.email });
      return answer(200, { ok: true, access_token: access, token_type: "bot", scope: c.scope.split(/[\s,]+/).filter(Boolean).join(","), bot_user_id: "U0BOT", app_id: "A0FAKE", team: { id: c.user.id, name: c.user.email }, authed_user: { id: "U0INSTALLER" } });
    }
    if (slackMethod === "auth.revoke") {
      // The token comes as a form field (what Daloy sends) or as the bearer. app.revokeStatus other than 200 makes it answer ok false.
      const form = new URLSearchParams(raw);
      const token = form.get("token") ?? (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (oauth.v2!.revokeStatus !== 200 || !slack.installs.has(token)) return json(res, 200, { ok: false, error: "invalid_auth" });
      slack.installs.delete(token);
      slack.revokedInstalls.push(token);
      return answer(200, { ok: true, revoked: true });
    }
    if (slackMethod) {
      const form = new URLSearchParams(raw);
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const install = slack.installs.get(token);
      if (!install && (!slack.token || token !== slack.token)) return json(res, 200, { ok: false, error: "invalid_auth" });
      if (slack.revoked) return json(res, 200, { ok: false, error: "token_revoked" });
      if (slackMethod === "auth.test") return json(res, 200, { ok: true, team: install?.team ?? slack.team, user: "daloy", team_id: install?.teamId ?? "T0FAKE" });
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
    // Airtable: a personal access token or an OAuth access token, 401 for a bad one, 404 for another base or table. Each added record gets an id.
    if (path.startsWith("/v0/")) {
      const airtableUser = oauthWho("airtable", req);
      if (airtable.revoked || !(airtableUser || (airtable.token && req.headers.authorization === `Bearer ${airtable.token}`))) return json(res, 401, { error: { type: "AUTHENTICATION_REQUIRED" } });
      if (path === "/v0/meta/whoami") return json(res, 200, { id: airtableUser?.id ?? "usrPAT", scopes: [] });
      if (path === "/v0/meta/bases") return json(res, 200, { bases: airtable.bases.map((b) => ({ id: b.id, name: b.name, permissionLevel: b.permissionLevel })) });
      const tables = /^\/v0\/meta\/bases\/([^/]+)\/tables$/.exec(path);
      if (tables) {
        const b = airtable.bases.find((x) => x.id === tables[1]);
        return b ? json(res, 200, { tables: b.tables.map((t) => ({ id: t.id, name: t.name, fields: [] })) }) : json(res, 404, { error: { type: "NOT_FOUND" } });
      }
      const at = /^\/v0\/([^/]+)\/([^/]+)$/.exec(path);
      if (at) {
        if (!airtable.bases.some((b) => b.id === at[1] && b.tables.some((t) => t.id === at[2]))) return json(res, 404, { error: { type: "TABLE_NOT_FOUND" } });
        if (req.method === "GET") return json(res, 200, { records: airtable.records.slice(0, 1) });
        const fields = (JSON.parse(raw) as { fields?: Record<string, unknown> }).fields ?? {};
        const id = `rec${String(++seq).padStart(14, "0")}`;
        airtable.records.push({ id, fields });
        return answer(200, { id, fields, createdTime: new Date().toISOString() });
      }
    }
    // Notion: a bearer token (internal secret or OAuth access token) and a Notion-Version header. A page needs the database's title property.
    if (path.startsWith("/v1/")) {
      const notionUser = oauthWho("notion", req);
      if (notion.revoked || !(notionUser || (notion.token && req.headers.authorization === `Bearer ${notion.token}`))) return json(res, 401, { object: "error", code: "unauthorized" });
      if (!req.headers["notion-version"]) return json(res, 400, { object: "error", code: "missing_version" });
      const databases = [{ id: notion.database, title: notion.title, titleProperty: notion.titleProperty }, ...notion.more];
      const known = (id: string | undefined) => databases.find((d) => d.id === (id ?? "").replace(/-/g, ""));
      const properties = (d: (typeof databases)[number]) => ({ [d.titleProperty]: { type: "title" }, Notes: { type: "rich_text" } });
      if (req.method === "GET" && path === "/v1/users/me") return json(res, 200, { object: "user", id: notionUser?.id ?? "notion-static-bot", type: "bot", name: "Daloy", bot: { workspace_name: notion.workspace } });
      if (req.method === "POST" && path === "/v1/search") {
        // Like Notion, a database filter returns databases only; without it pages come back too.
        const q = JSON.parse(raw || "{}") as { filter?: { value?: string }; page_size?: number; start_cursor?: string };
        const all = [...databases.map((d) => ({ object: "database", id: dashed(d.id), title: [{ plain_text: d.title }], properties: properties(d) })), ...(q.filter?.value === "database" ? [] : [{ object: "page", id: dashed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") }])];
        const size = q.page_size ?? 100;
        const from = Number(q.start_cursor ?? 0);
        const next = from + size;
        return json(res, 200, { object: "list", results: all.slice(from, next), has_more: next < all.length, next_cursor: next < all.length ? String(next) : null });
      }
      const one = /^\/v1\/databases\/([^/]+)$/.exec(path);
      if (req.method === "GET" && one) {
        const d = known(one[1]);
        return d ? json(res, 200, { object: "database", id: d.id, title: [{ plain_text: d.title }], properties: properties(d) }) : json(res, 404, { object: "error", code: "object_not_found" });
      }
      if (req.method === "POST" && path === "/v1/pages") {
        const page = JSON.parse(raw) as { parent?: { database_id?: string }; properties?: Record<string, { title?: unknown }> };
        const d = known(page.parent?.database_id);
        if (!d) return json(res, 404, { object: "error", code: "object_not_found" });
        if (!page.properties?.[d.titleProperty]?.title) return json(res, 400, { object: "error", code: "validation_error" });
        const id = `page-${++seq}`;
        notion.pages.push({ id, properties: page.properties });
        return answer(200, { object: "page", id });
      }
      return json(res, 404, { object: "error", code: "object_not_found" });
    }
    // Trello: key and token in the query string, or an OAuth 2.0 access token as a bearer header. Answers are plain text on errors, like the real API.
    if (path.startsWith("/1/")) {
      const q = url.searchParams;
      const trelloUser = oauthWho("trello", req);
      const pasted = trello.token && q.get("key") === trello.key && q.get("token") === trello.token;
      if (trello.revoked || !(trelloUser || pasted)) return res.writeHead(401, { "content-type": "text/plain" }).end("invalid token");
      const lists = trello.boards.flatMap((b) => b.lists);
      const open = (l: { closed: boolean }) => q.get("filter") !== "open" || !l.closed;
      if (path === "/1/members/me") return json(res, 200, { id: trelloUser?.id ?? "static-member", username: trello.username });
      if (path === "/1/members/me/boards") return json(res, 200, trello.boards.map((b) => ({ id: b.id, name: b.name })));
      const boardLists = /^\/1\/boards\/([^/]+)\/lists$/.exec(path);
      if (boardLists) {
        const b = trello.boards.find((x) => x.id === boardLists[1]);
        return b ? json(res, 200, b.lists.filter(open).map((l) => ({ id: l.id, name: l.name }))) : res.writeHead(404, { "content-type": "text/plain" }).end("The requested resource was not found.");
      }
      const list = /^\/1\/lists\/([^/]+)$/.exec(path);
      if (list) {
        const l = lists.find((x) => x.id === list[1]);
        return l ? json(res, 200, { id: l.id, name: l.name }) : res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      }
      if (path === "/1/cards" && req.method === "POST") {
        const c = JSON.parse(raw) as { idList?: string; name?: string; desc?: string };
        if (!lists.some((l) => l.id === c.idList)) return res.writeHead(400, { "content-type": "text/plain" }).end("invalid value for idList");
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
    urls: { googleToken: `${base}/token`, sheets: base, calendar: base, drive: base, paymongo: base, airtable: base, notion: base, trello: base, slack: base, telegram: base, microsoftLogin: `${base}/ms`, graph: `${base}/graph`, gmail: base, airtableLogin: `${base}/airtable-login`, trelloLogin: `${base}/atlassian`, teamsHosts: ["127.0.0.1"] },
    /** The installation's OAuth clients for the record apps, as providerUrls() would read them from env (decision 0062). */
    recordClients: () => ({
      airtableClient: { clientId: oauth.airtable!.clientId, clientSecret: oauth.airtable!.clientSecret },
      notionClient: { clientId: oauth.notion!.clientId, clientSecret: oauth.notion!.clientSecret },
      trelloClient: { clientId: oauth.trello!.clientId, clientSecret: oauth.trello!.clientSecret },
    }),
    calls,
    slack,
    telegram,
    airtable,
    notion,
    trello,
    microsoft,
    teams,
    gmail,
    oauth,
    /** Adds another generic OAuth app, for a provider phase or a test that needs a second one. */
    addOAuthApp: (name: string, o?: Parameters<typeof oauthApp>[1]) => (oauth[name] = oauthApp(name, o)),
    oauthUrls: (name: string) => ({ authorize: `${base}/oauth/${name}/authorize`, token: `${base}/oauth/${name}/token`, revoke: `${base}/oauth/${name}/revoke`, userinfo: `${base}/oauth/${name}/userinfo` }),
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
    /** A spreadsheet by id, such as one Daloy created through the API. */
    sheet: (id: string) => sheets.get(id),
    /** A Drive folder by id, such as one Daloy created through the API. */
    driveFolder: (id: string) => driveFolders.get(id),
    /** A calendar by id, such as one Daloy created through the API. */
    calendar: (id: string) => calendars.get(id),
    addCalendar: (id: string, title: string, editors: string[]) => {
      const c = { title, editors: new Set(editors), events: new Map<string, CalendarEvent>() };
      calendars.set(id, c);
      return c;
    },
    addDriveFolder: (id: string, name: string, editors: string[], sharedDriveId: string | null) => {
      driveFolders.set(id, { name, editors: new Set(editors), sharedDriveId });
    },
    driveFiles,
    once: (path: string, behaviour: Behaviour, skip = 0) => pending.push({ path, behaviour, skip }),
    async close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
