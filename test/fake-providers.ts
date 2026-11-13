import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake Google (token endpoint and Sheets API) and Slack Web API on one local port, for tests. Nothing here talks to
 * the real services. The Google side checks the service account's JWT signature, so a wrong key fails like it would.
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
      if (req.method === "POST") slack.channels[0]!.is_member = (JSON.parse(raw) as { slackMember: boolean }).slackMember;
      return json(res, 200, { sheetRows: [...sheets.values()].flatMap((s) => [...s.tabs.values()].flat()).length, slackMessages: slack.messages.map((m) => m.text) });
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
      return answer(200, { values: tab.map((r) => [r[0]]) });
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
    urls: { googleToken: `${base}/token`, sheets: base, slack: base },
    calls,
    slack,
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
