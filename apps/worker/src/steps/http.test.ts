import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "node:net";
import { StepError } from "@daloy/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpRequest, type HttpOptions } from "./http";
import { BLOCKED_RANGES, blockListOf, type SsrfGuard } from "./ssrf";

// The test server listens on 127.0.0.1, so these tests use the full block list minus 127/8.
// A fake resolver maps "public.test" and "other.test" to the server and "private.test" to 10.0.0.1.
let server: Server;
let port: number;
let requests = 0;
let orders = 0;
// Accepts a TCP connection and closes it at once, before reading anything.
let dropper: TcpServer;
let dropPort: number;
// A port nothing listens on.
let closedPort: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    const path = req.url!;
    const at = (p: string) => path.startsWith(p);
    if (at("/json")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, key: req.headers["idempotency-key"] }));
    if (at("/text")) return res.writeHead(200, { "content-type": "text/plain" }).end("hello");
    if (at("/echo")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ method: req.method, auth: req.headers.authorization ?? null }));
    if (at("/status/")) return res.writeHead(Number(path.slice(8))).end();
    if (at("/redirect/")) return res.writeHead(302, { location: decodeURIComponent(path.slice(10)) }).end();
    if (at("/redirect307/")) return res.writeHead(307, { location: decodeURIComponent(path.slice(13)) }).end();
    if (at("/chain/")) {
      const n = Number(path.slice(7));
      return res.writeHead(302, { location: n > 0 ? `/chain/${n - 1}` : "/json" }).end();
    }
    if (at("/big503")) return res.writeHead(503).end(Buffer.alloc(2_000_000, 97));
    if (at("/big")) return res.writeHead(200).end(Buffer.alloc(2_000_000, 97));
    // An order endpoint that takes the POST and sends the client on to a receipt (Astra, b31c4ce).
    if (at("/order/")) {
      if (req.method === "POST") orders++;
      return res.writeHead(303, { location: `/receipt/${path.slice(7)}` }).end();
    }
    if (at("/receipt/")) return res.writeHead(Number(path.slice(9)), { "retry-after": "0" }).end();
    if (at("/hang")) return; // never answers
    if (at("/retry-after/")) return res.writeHead(429, { "retry-after": decodeURIComponent(path.slice(13)) }).end();
    // Reads the whole request, then drops the connection without answering.
    if (at("/reset")) return req.on("end", () => req.socket.destroy()).resume();
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  dropper = createTcpServer((socket) => socket.destroy());
  await new Promise<void>((r) => dropper.listen(0, "127.0.0.1", r));
  dropPort = (dropper.address() as AddressInfo).port;
  const spare = createTcpServer();
  await new Promise<void>((r) => spare.listen(0, "127.0.0.1", r));
  closedPort = (spare.address() as AddressInfo).port;
  await new Promise((r) => spare.close(r));
});

afterAll(async () => {
  dropper.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

function guard(resolve?: SsrfGuard["resolve"]): SsrfGuard {
  return {
    blockList: blockListOf(BLOCKED_RANGES.filter(([net]) => net !== "127.0.0.0")),
    ports: ["", "80", "443", String(port), String(dropPort), String(closedPort)],
    resolve:
      resolve ??
      (async (host) => {
        if (host === "public.test" || host === "other.test") return [{ address: "127.0.0.1", family: 4 }];
        if (host === "private.test") return [{ address: "10.0.0.1", family: 4 }];
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      }),
  };
}

const base = () => `http://public.test:${port}`;
const get = (path: string, opts: Partial<HttpOptions> = {}, headers: Record<string, string> = {}) =>
  httpRequest({ method: "GET", url: base() + path, headers }, "run:step", { guard: guard(), ...opts });
const post = (path: string, cfg: { idempotent?: boolean } = {}, opts: Partial<HttpOptions> = {}) =>
  httpRequest({ method: "POST", url: base() + path, headers: {}, body: '{"order":"A-1"}', ...cfg }, "run:step", { guard: guard(), ...opts });

async function stepError(p: Promise<unknown>): Promise<StepError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StepError);
  return err as StepError;
}

describe("httpRequest", () => {
  it("connects to the address the guarded lookup approved and parses JSON", async () => {
    const out = await get("/json");
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, key: "run:step" });
  });

  it("returns text bodies as strings", async () => {
    expect((await get("/text")).body).toBe("hello");
  });

  it("sends the method, body and headers", async () => {
    const out = await httpRequest({ method: "POST", url: `${base()}/echo`, headers: { Authorization: "Bearer t" }, body: "{}" }, "k", { guard: guard() });
    expect(out.body).toEqual({ method: "POST", auth: "Bearer t" });
  });

  it("marks 5xx and 408 as unknown, retried only when the step is idempotent, and other 4xx as rejected", async () => {
    for (const code of [503, 500, 408]) {
      const onGet = await stepError(get(`/status/${code}`));
      expect([onGet.outcome, onGet.retryable], `GET ${code}`).toEqual(["unknown", true]);
      const onPost = await stepError(post(`/status/${code}`));
      expect([onPost.outcome, onPost.retryable], `POST ${code}`).toEqual(["unknown", false]);
    }
    const flagged = await stepError(post("/status/503", { idempotent: true }));
    expect([flagged.outcome, flagged.retryable]).toEqual(["unknown", true]);
    const unsafePut = await stepError(httpRequest({ method: "PUT", url: `${base()}/status/503`, headers: {}, idempotent: false }, "k", { guard: guard() }));
    expect(unsafePut.retryable).toBe(false);
    for (const code of [400, 404, 422]) {
      const err = await stepError(post(`/status/${code}`));
      expect([err.outcome, err.retryable], `POST ${code}`).toEqual(["rejected", false]);
    }
  });

  it("marks a 429 as throttled, retried even on a POST, and keeps Retry-After in seconds or as a date", async () => {
    const seconds = await stepError(post("/retry-after/7"));
    expect([seconds.outcome, seconds.retryable, seconds.retryAfterMs]).toEqual(["throttled", true, 7000]);
    const at = new Date(Date.now() + 30_000).toUTCString();
    const date = await stepError(post(`/retry-after/${encodeURIComponent(at)}`));
    expect(date.retryAfterMs).toBeGreaterThan(25_000);
    expect(date.retryAfterMs).toBeLessThanOrEqual(30_000);
    const none = await stepError(post("/status/429"));
    expect([none.outcome, none.retryAfterMs]).toEqual(["throttled", undefined]);
    const junk = await stepError(post("/retry-after/soon"));
    expect(junk.retryAfterMs).toBeUndefined();
  });

  it("marks a POST whose connection drops after the receiver read the body as unknown, not retried", async () => {
    const before = requests;
    const err = await stepError(post("/reset"));
    expect([err.outcome, err.retryable]).toEqual(["unknown", false]);
    expect(requests).toBe(before + 1);
  });

  it("marks a POST that times out after connecting as unknown, not retried", async () => {
    const err = await stepError(post("/hang", {}, { timeoutMs: 200 }));
    expect(err.message).toMatch(/timed out/);
    expect([err.outcome, err.retryable]).toEqual(["unknown", false]);
  });

  it("marks a plain HTTP connection the receiver accepted and then closed as unknown, since request bytes may have reached it", async () => {
    const err = await stepError(httpRequest({ method: "POST", url: `http://public.test:${dropPort}/`, headers: {}, body: "{}" }, "k", { guard: guard() }));
    expect([err.outcome, err.retryable]).toEqual(["unknown", false]);
  });

  it("marks an HTTPS connection closed before the TLS handshake finished as not_sent, since no request byte can have been written", async () => {
    const err = await stepError(httpRequest({ method: "POST", url: `https://public.test:${dropPort}/`, headers: {}, body: "{}" }, "k", { guard: guard() }));
    expect([err.outcome, err.retryable]).toEqual(["not_sent", true]);
  });

  it("marks a refused connection and a failed DNS lookup as not_sent and retries them even on a POST", async () => {
    const refused = await stepError(httpRequest({ method: "POST", url: `http://public.test:${closedPort}/`, headers: {}, body: "{}" }, "k", { guard: guard() }));
    expect([refused.outcome, refused.retryable]).toEqual(["not_sent", true]);
    const dns = await stepError(httpRequest({ method: "POST", url: "http://nowhere.test/", headers: {}, body: "{}" }, "k", { guard: guard() }));
    expect([dns.outcome, dns.retryable]).toEqual(["not_sent", true]);
  });

  it("marks an SSRF refusal as not_sent but never retries it, since it cannot pass", async () => {
    const err = await stepError(httpRequest({ method: "POST", url: `http://private.test:${port}/json`, headers: {}, body: "{}" }, "k", { guard: guard() }));
    expect([err.outcome, err.retryable]).toEqual(["not_sent", false]);
  });

  it("follows up to 3 redirects and refuses a 4th", async () => {
    expect((await get("/chain/2")).body).toMatchObject({ ok: true });
    const err = await stepError(get("/chain/3"));
    expect(err.message).toMatch(/redirects/);
    expect(err.retryable).toBe(false);
  });

  it("blocks a redirect to a private address or a blocked scheme", async () => {
    for (const target of [`http://private.test:${port}/json`, "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd", "http://[::1]/"]) {
      const err = await stepError(get(`/redirect/${encodeURIComponent(target)}`));
      expect(err.retryable, target).toBe(false);
    }
  });

  it("drops the caller's headers on a redirect to another origin", async () => {
    const target = encodeURIComponent(`http://other.test:${port}/echo`);
    const out = await get(`/redirect/${target}`, {}, { Authorization: "Bearer t" });
    expect(out.body).toEqual({ method: "GET", auth: null });
  });

  it("never resends a body to another origin on a 307 or 308, but follows one on the same origin", async () => {
    const post = (target: string) =>
      httpRequest({ method: "POST", url: `${base()}/redirect307/${encodeURIComponent(target)}`, headers: {}, body: '{"private":true}' }, "k", { guard: guard() });
    const before = requests;
    const err = await stepError(post(`http://other.test:${port}/echo`));
    expect(err.retryable).toBe(false);
    expect(requests).toBe(before + 1);
    expect((await post(`http://public.test:${port}/echo`)).body).toEqual({ method: "POST", auth: null });
  });

  it("checks every resolution, so a DNS answer that changes to a private address is blocked", async () => {
    let calls = 0;
    const rebinding = guard(async () => [{ address: ++calls === 1 ? "127.0.0.1" : "10.0.0.1", family: 4 }]);
    const url = `${base()}/redirect/${encodeURIComponent(`http://public.test:${port}/json`)}`;
    const err = await stepError(httpRequest({ method: "GET", url, headers: {} }, "k", { guard: rebinding }));
    expect(err.retryable).toBe(false);
    expect(calls).toBe(2);
  });

  it("refuses a blocked IP literal without connecting", async () => {
    const before = requests;
    const strict = { ...guard(), blockList: blockListOf() };
    const err = await stepError(httpRequest({ method: "GET", url: `http://127.0.0.1:${port}/json`, headers: {} }, "k", { guard: strict }));
    expect(err.retryable).toBe(false);
    expect(requests).toBe(before);
  });

  it("stops reading after the size limit", async () => {
    const err = await stepError(get("/big", { maxBytes: 1_000_000 }));
    expect(err.message).toMatch(/1000000 bytes/);
    expect(err.retryable).toBe(false);
  });

  it("never retries a POST the receiver already answered with a redirect, whatever the follow-up does", async () => {
    for (const code of [429, 503, 404]) {
      const before = orders;
      const err = await stepError(post(`/order/${code}`));
      expect([err.outcome, err.retryable], `receipt ${code}`).toEqual(["unknown", false]);
      expect(orders - before).toBe(1);
    }
    const refused = await stepError(post(`/redirect/${encodeURIComponent(`http://private.test:${port}/json`)}`));
    expect([refused.outcome, refused.retryable]).toEqual(["unknown", false]);
  });

  it("still retries an idempotent step whose redirect target is throttled", async () => {
    const err = await stepError(post("/order/429", { idempotent: true }));
    expect([err.outcome, err.retryable]).toEqual(["throttled", true]);
  });

  it("keeps a 503 unknown when its body is over the size limit", async () => {
    const err = await stepError(post("/big503", {}, { maxBytes: 1_000_000 }));
    expect([err.message, err.outcome, err.retryable]).toEqual([expect.stringMatching(/HTTP 503/), "unknown", false]);
  });

  it("asks for the send claim once, right before the first request, and refuses to send without it", async () => {
    const before = requests;
    const err = await stepError(post("/json", {}, { claim: () => Promise.reject(new StepError("claim lost", false, { outcome: "not_sent" })) }));
    expect([err.outcome, err.retryable]).toEqual(["not_sent", false]);
    expect(requests).toBe(before);
    const events: string[] = [];
    const out = await post("/chain/1", {}, { claim: async () => (events.push("claimed"), () => events.push("released")) });
    expect(out.status).toBe(200);
    expect(events).toEqual(["claimed", "released"]);
  });

  it("times out a GET as a retryable unknown outcome", async () => {
    const err = await stepError(get("/hang", { timeoutMs: 200 }));
    expect(err.message).toMatch(/timed out/);
    expect([err.outcome, err.retryable]).toEqual(["unknown", true]);
  });
});
