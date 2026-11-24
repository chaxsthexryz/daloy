import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { discordPost, discordWebhookUrl, DISCORD_HOSTS } from "./discord";
import { ProviderError, type ProviderUrls } from "./providers";

// Phase I1, decision 0104. The webhook URL is a credential: it is checked before it is stored or called, and no error
// kymavo builds may carry it. Everything runs against a local stub, never against Discord.
const ID = "123456789012345678";
const TOKEN = "tok_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGhIjKlMnOpQrSt"; // gitleaks:allow (synthetic)
const good = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;
const urls = (hosts?: string[]) => ({ discordHosts: hosts, timeoutMs: 1000 }) as ProviderUrls;

describe("discordWebhookUrl", () => {
  it("accepts discord.com, discordapp.com and their subdomains over https", () => {
    for (const host of ["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]) {
      expect(discordWebhookUrl(urls(), `https://${host}/api/webhooks/${ID}/${TOKEN}`), host).toBe(`https://${host}/api/webhooks/${ID}/${TOKEN}`);
    }
    expect(discordWebhookUrl(urls(), `  ${good}  `)).toBe(good);
    expect(discordWebhookUrl(urls(), `https://discord.com/api/v10/webhooks/${ID}/${TOKEN}`)).toBeTruthy();
  });

  it("lists exactly the two Discord hosts by default", () => {
    expect([...DISCORD_HOSTS]).toEqual(["discord.com", "discordapp.com"]);
  });

  it.each([
    ["http", `http://discord.com/api/webhooks/${ID}/${TOKEN}`],
    ["another host", `https://example.com/api/webhooks/${ID}/${TOKEN}`],
    ["a lookalike host", `https://discord.com.evil.example/api/webhooks/${ID}/${TOKEN}`],
    ["a host that only ends the same", `https://notdiscord.com/api/webhooks/${ID}/${TOKEN}`],
    ["a host with a prefix hyphen", `https://evil-discord.com/api/webhooks/${ID}/${TOKEN}`],
    ["user info before the host", `https://discord.com@evil.example/api/webhooks/${ID}/${TOKEN}`],
    ["a password", `https://user:pw@discord.com/api/webhooks/${ID}/${TOKEN}`],
    ["a path that is not a webhook", `https://discord.com/api/channels/${ID}/messages`],
    ["a webhook id with letters", `https://discord.com/api/webhooks/abc/${TOKEN}`],
    ["a missing token", `https://discord.com/api/webhooks/${ID}`],
    ["a path after the token", `https://discord.com/api/webhooks/${ID}/${TOKEN}/github`],
    ["a query string", `https://discord.com/api/webhooks/${ID}/${TOKEN}?thread_id=1`],
    ["a fragment", `https://discord.com/api/webhooks/${ID}/${TOKEN}#x`],
    ["an IP address", `https://127.0.0.1/api/webhooks/${ID}/${TOKEN}`],
    ["not a URL", "discord"],
    ["an empty string", ""],
  ])("refuses %s", (_what, input) => {
    expect(discordWebhookUrl(urls(), input)).toBeNull();
  });

  it("allows http only on a host a test lists, and still demands the webhook path", () => {
    expect(discordWebhookUrl(urls(["127.0.0.1"]), `http://127.0.0.1:9000/api/webhooks/${ID}/${TOKEN}`)).toBeTruthy();
    expect(discordWebhookUrl(urls(["127.0.0.1"]), "http://127.0.0.1:9000/anything")).toBeNull();
    expect(discordWebhookUrl(urls(), `http://127.0.0.1:9000/api/webhooks/${ID}/${TOKEN}`)).toBeNull();
    // http stays refused for a real Discord host even when a test host is listed.
    expect(discordWebhookUrl(urls(["127.0.0.1"]), `http://discord.com/api/webhooks/${ID}/${TOKEN}`)).toBeNull();
  });
});

describe("discordPost", () => {
  let stub: Server;
  let answer: { status: number; headers?: Record<string, string>; body?: unknown } = { status: 200 };
  let seen: { url: string; method: string; type: string | undefined; body: Record<string, unknown> }[] = [];
  let u: ProviderUrls;
  let hook: string;

  const read = (req: IncomingMessage) => new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c: Buffer) => (b += c.toString()));
    req.on("end", () => resolve(b));
  });

  beforeAll(async () => {
    stub = createServer((req, res) => {
      void read(req).then((raw) => {
        seen.push({ url: req.url ?? "", method: req.method ?? "", type: req.headers["content-type"], body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
        if (answer.status === 0) return req.socket.destroy();
        res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers }).end(answer.body === undefined ? "" : JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const port = (stub.address() as AddressInfo).port;
    u = urls(["127.0.0.1"]);
    hook = `http://127.0.0.1:${port}/api/webhooks/${ID}/${TOKEN}`;
  });
  afterAll(() => void stub.close());
  beforeEach(() => {
    seen = [];
    answer = { status: 200, body: { id: "1100000000000000001" } };
  });

  const failure = async (text = "hello") => {
    const err = await discordPost(u, hook, text).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  };

  it("posts the text as JSON, asks Discord to wait, and stops @everyone and role pings", async () => {
    const out = await discordPost(u, hook, "New order @everyone <@&99>");
    expect(out).toEqual({ posted: true, messageId: "1100000000000000001" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", type: "application/json", body: { content: "New order @everyone <@&99>", allowed_mentions: { parse: [] } } });
    expect(seen[0]!.url).toBe(`/api/webhooks/${ID}/${TOKEN}?wait=true`);
  });

  it("treats 204 as posted", async () => {
    answer = { status: 204 };
    expect(await discordPost(u, hook, "x")).toEqual({ posted: true });
  });

  it("refuses a message Discord would refuse, before any request", async () => {
    const err = await failure("a".repeat(2001));
    expect(err.kind).toBe("invalid");
    expect(seen).toHaveLength(0);
    expect((await failure("   ")).kind).toBe("invalid");
  });

  it("refuses a URL on another host without calling it", async () => {
    const err = await discordPost(urls(), `https://example.com/api/webhooks/${ID}/${TOKEN}`, "x").then(() => undefined, (e: unknown) => e);
    expect((err as ProviderError).kind).toBe("auth");
    expect(seen).toHaveLength(0);
  });

  describe("rate limits", () => {
    it("maps 429 to quota and waits as long as Retry-After says", async () => {
      answer = { status: 429, headers: { "retry-after": "7" }, body: { message: "You are being rate limited.", retry_after: 7, global: false } };
      const err = await failure();
      expect(err.kind).toBe("quota");
      expect(err.retryAfterMs).toBe(7000);
    });
    it("falls back to the retry_after seconds in the body, which Discord sends as a fraction", async () => {
      answer = { status: 429, body: { message: "You are being rate limited.", retry_after: 1.5, global: true } };
      const err = await failure();
      expect(err.kind).toBe("quota");
      expect(err.retryAfterMs).toBe(1500);
    });
    it("caps a huge wait at the provider limit and keeps quota when no hint comes", async () => {
      answer = { status: 429, body: { retry_after: 86_400 } };
      expect((await failure()).retryAfterMs).toBe(10 * 60_000);
      answer = { status: 429, body: {} };
      expect(await failure()).toMatchObject({ kind: "quota", retryAfterMs: undefined });
    });
  });

  describe("error mapping", () => {
    it.each([
      [401, "auth"],
      [403, "auth"],
      [404, "auth"],
      [400, "invalid"],
      [413, "invalid"],
      [500, "ambiguous"],
      [502, "ambiguous"],
      [503, "ambiguous"],
    ] as const)("maps %s to %s", async (status, kind) => {
      answer = { status, body: { message: "Unknown Webhook", code: 10015 } };
      expect((await failure()).kind).toBe(kind);
    });
    it("tells the owner a deleted webhook needs a new link", async () => {
      answer = { status: 404, body: { message: "Unknown Webhook", code: 10015 } };
      expect((await failure()).message).toMatch(/deleted|new webhook/i);
    });
    it("maps a connection dropped after the request left to ambiguous", async () => {
      answer = { status: 0 };
      expect((await failure()).kind).toBe("ambiguous");
    });
    it("does not follow a redirect", async () => {
      answer = { status: 307, headers: { location: "http://127.0.0.1:1/elsewhere" } };
      expect(await failure()).toBeInstanceOf(ProviderError);
    });
  });

  describe("the URL is never echoed", () => {
    const leaks = (m: string) => [TOKEN, ID, "127.0.0.1", "/api/webhooks", "wait=true"].filter((needle) => m.includes(needle));
    it.each([400, 401, 404, 429, 500])("in the error for a %s answer, even when Discord echoes it", async (status) => {
      // A hostile or misconfigured server may echo the URL it was called with.
      answer = { status, headers: { "retry-after": "1" }, body: { message: `bad ${hook}`, url: hook, retry_after: 1 } };
      expect(leaks((await failure()).message)).toEqual([]);
    });
    it("in the error for a message that is too long or an address that is refused", async () => {
      expect(leaks((await failure("a".repeat(2001))).message)).toEqual([]);
      const err = await discordPost(urls(), `https://example.com/api/webhooks/${ID}/${TOKEN}`, "x").then(() => undefined, (e: unknown) => e);
      expect(leaks((err as ProviderError).message)).toEqual([]);
    });
    it("in the result of a successful post", async () => {
      answer = { status: 200, body: { id: "1", webhook_id: ID, content: "x" } };
      expect(JSON.stringify(await discordPost(u, hook, "x"))).not.toContain(TOKEN);
    });
  });
});
