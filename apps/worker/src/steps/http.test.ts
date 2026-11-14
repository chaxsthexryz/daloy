import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StepError } from "@daloy/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpRequest, type HttpOptions } from "./http";
import { BLOCKED_RANGES, blockListOf, type SsrfGuard } from "./ssrf";

// The test server listens on 127.0.0.1, so these tests use the full block list minus 127/8.
// A fake resolver maps "public.test" and "other.test" to the server and "private.test" to 10.0.0.1.
let server: Server;
let port: number;
let requests = 0;

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
    if (at("/big")) return res.writeHead(200).end(Buffer.alloc(2_000_000, 97));
    if (at("/hang")) return; // never answers
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

function guard(resolve?: SsrfGuard["resolve"]): SsrfGuard {
  return {
    blockList: blockListOf(BLOCKED_RANGES.filter(([net]) => net !== "127.0.0.0")),
    ports: ["", "80", "443", String(port)],
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
  httpRequest({ method: "GET", url: base() + path, headers }, "run:step:1", { guard: guard(), ...opts });

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
    expect(out.body).toEqual({ ok: true, key: "run:step:1" });
  });

  it("returns text bodies as strings", async () => {
    expect((await get("/text")).body).toBe("hello");
  });

  it("sends the method, body and headers", async () => {
    const out = await httpRequest({ method: "POST", url: `${base()}/echo`, headers: { Authorization: "Bearer t" }, body: "{}" }, "k", { guard: guard() });
    expect(out.body).toEqual({ method: "POST", auth: "Bearer t" });
  });

  it("marks 5xx and 429 as retryable and other 4xx as final", async () => {
    expect((await stepError(get("/status/503"))).retryable).toBe(true);
    expect((await stepError(get("/status/429"))).retryable).toBe(true);
    expect((await stepError(get("/status/404"))).retryable).toBe(false);
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

  it("times out as a retryable error", async () => {
    const err = await stepError(get("/hang", { timeoutMs: 200 }));
    expect(err.message).toMatch(/timed out/);
    expect(err.retryable).toBe(true);
  });

  it("treats DNS and connection failures as retryable", async () => {
    const err = await stepError(httpRequest({ method: "GET", url: "http://nowhere.test/", headers: {} }, "k", { guard: guard() }));
    expect(err.retryable).toBe(true);
  });
});
