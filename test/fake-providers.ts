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
 */
type Behaviour = { status: number; body: unknown; headers?: Record<string, string> } | "hang" | "hang-after";

export type FakeProviders = Awaited<ReturnType<typeof startFakeProviders>>;

export async function startFakeProviders(port = 0) {
  const keys = new Map<string, KeyObject>(); // service account email -> public key
  const revoked = new Set<string>();
  const tokens = new Map<string, string>(); // access token -> email
  const sheets = new Map<string, { title: string; tabs: Map<string, string[][]>; editors: Set<string> }>();
  const slack = { token: "", team: "Lim Dental", channels: [{ id: "C0REQ", name: "office-requests", is_member: true }], messages: [] as { channel: string; text: string; ts: string }[], revoked: false };
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
    if (behaviour && behaviour !== "hang-after") return json(res, behaviour.status, behaviour.body, behaviour.headers);
    const answer = (status: number, b: unknown, headers?: Record<string, string>) => (behaviour === "hang-after" ? void hanging.add(res) : json(res, status, b, headers));

    // For the e2e suite, whose tests run in other processes: read counts, and take the Slack app out of the channel.
    if (path === "/__control") {
      if (req.method === "POST") {
        const c = JSON.parse(raw) as { slackMember?: boolean; microsoftConsent?: typeof microsoft.consent };
        if (c.slackMember !== undefined) slack.channels[0]!.is_member = c.slackMember;
        if (c.microsoftConsent) microsoft.consent = c.microsoftConsent;
      }
      return json(res, 200, {
        sheetRows: [...sheets.values()].flatMap((s) => [...s.tabs.values()].flat()).length,
        slackMessages: slack.messages.map((m) => m.text),
        outlookMessages: microsoft.sent,
        teamsPosts: teams.posts.map((p) => p.text),
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
      return json(res, 200, { token_type: "Bearer", access_token: access, refresh_token: refresh, expires_in: 3599, scope: "Mail.Send User.Read" });
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

    // Google Sheets API v4.
    const sheetPath = /^\/v4\/spreadsheets\/([^/]+)(?:\/values\/(.+?)(:append)?)?$/.exec(path);
    if (sheetPath) {
      const email = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!email) return googleError(res, 401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
      const sheet = sheets.get(sheetPath[1]!);
      if (!sheet) return googleError(res, 404, "NOT_FOUND", "Requested entity was not found.");
      if (!sheet.editors.has(email)) return googleError(res, 403, "PERMISSION_DENIED", "The caller does not have permission");
      if (!sheetPath[2]) return answer(200, { properties: { title: sheet.title }, sheets: [...sheet.tabs.keys()].map((title) => ({ properties: { title } })) });
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
    json(res, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    urls: { googleToken: `${base}/token`, sheets: base, slack: base, microsoftLogin: `${base}/ms`, graph: `${base}/graph`, teamsHosts: ["127.0.0.1"] },
    calls,
    slack,
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
      const s = { title, tabs: new Map([[tab, [] as string[][]]]), editors: new Set(editors) };
      sheets.set(id, s);
      return s;
    },
    once: (path: string, behaviour: Behaviour) => pending.push({ path, behaviour }),
    async close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
