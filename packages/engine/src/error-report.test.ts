import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createErrorReporter, parseSentryDsn, scrubValue } from "./error-report";

describe("error-report (A2)", () => {
  it("parses Sentry and GlitchTip DSNs and rejects blank or malformed values", () => {
    expect(parseSentryDsn(undefined)).toBeNull();
    expect(parseSentryDsn("   ")).toBeNull();
    expect(parseSentryDsn("ftp://k@example.com/1")).toBeNull();
    expect(parseSentryDsn("https://k:secret@example.com/1")).toBeNull();
    expect(parseSentryDsn("https://example.com/1")).toBeNull();

    expect(parseSentryDsn("https://pub123@o10.ingest.sentry.io/456")).toEqual({
      storeUrl: "https://o10.ingest.sentry.io/api/456/store/",
      authHeader: "Sentry sentry_version=7, sentry_key=pub123, sentry_client=daloy/1.0",
      origin: "https://o10.ingest.sentry.io",
    });

    expect(parseSentryDsn("http://glk_1@glitchtip.local:8080/errors/7")).toEqual({
      storeUrl: "http://glitchtip.local:8080/errors/api/7/store/",
      authHeader: "Sentry sentry_version=7, sentry_key=glk_1, sentry_client=daloy/1.0",
      origin: "http://glitchtip.local:8080",
    });
  });

  it("scrubs secrets and URL query strings from reported values", () => {
    expect(
      scrubValue({
        path: "https://api.trello.com/1/cards?key=secret&token=tok",
        authorization: "Bearer 123",
        nested: { apiKey: "abc", note: "safe" },
      }),
    ).toEqual({
      path: "https://api.trello.com/1/cards",
      authorization: "[redacted]",
      nested: { apiKey: "[redacted]", note: "safe" },
    });
  });

  describe("HTTP capture", () => {
    const received: { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[] = [];
    let port = 0;
    let server: ReturnType<typeof createServer>;

    beforeAll(async () => {
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
          received.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
          res.writeHead(200, { "content-type": "application/json" }).end('{"id":"ok"}');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("posts scrubbed events, rate-limits bursts, and silently ignores unreachable hosts", async () => {
      const noop = createErrorReporter({ dsn: "", service: "api" });
      expect(noop.enabled).toBe(false);
      expect(await noop.capture(new Error("ignored"))).toBe(false);

      const reporter = createErrorReporter({
        dsn: `http://key123@127.0.0.1:${port}/99`,
        service: "worker",
        environment: "staging",
        maxPerMinute: 2,
      });
      expect(reporter.enabled).toBe(true);
      expect(await reporter.capture(new Error("failed calling https://x.test/hook?token=abc"), { extra: { secret: "xyz", step: "http" } })).toBe(true);
      expect(await reporter.capture(new Error("second"))).toBe(true);
      expect(await reporter.capture(new Error("rate limited"))).toBe(false);

      expect(received).toHaveLength(2);
      expect(received[0]!.headers["x-sentry-auth"]).toBe("Sentry sentry_version=7, sentry_key=key123, sentry_client=daloy/1.0");
      expect(received[0]!.body).toMatchObject({
        level: "error",
        platform: "node",
        environment: "staging",
        tags: { service: "worker" },
        exception: { values: [{ type: "Error", value: "failed calling https://x.test/hook" }] },
        extra: { secret: "[redacted]", step: "http" },
      });

      const down = createErrorReporter({ dsn: "http://k@127.0.0.1:1/99", service: "api", timeoutMs: 200 });
      expect(await down.capture(new Error("unreachable"))).toBe(false);
    });
  });
});
