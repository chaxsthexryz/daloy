import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixture, type Fixture } from "./fixture";
import { startProxy, type Proxy } from "./proxy";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const via = (proxy: Proxy) => new URL(proxy.url);

/** A plain http request sent through the proxy, the way Chromium sends one: the full address on the request line. */
function forward(proxy: Proxy, target: string): Promise<{ status: number; body: string }> {
  const p = via(proxy);
  return new Promise((resolve, reject) => {
    const req = request({ host: p.hostname, port: p.port, path: target, headers: { host: new URL(target).host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A CONNECT tunnel request, which Chromium uses for https and WebSockets. */
function tunnel(proxy: Proxy, target: string): Promise<number> {
  const p = via(proxy);
  return new Promise((resolve, reject) => {
    const req = request({ host: p.hostname, port: p.port, method: "CONNECT", path: target });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function withProxy(opts: Parameters<typeof startProxy>[0], fn: (p: Proxy) => Promise<void>) {
  const proxy = await startProxy(opts);
  try {
    await fn(proxy);
  } finally {
    await proxy.close();
  }
}

describe("browser proxy", () => {
  it("forwards to an exempt test address and connects to the address it checked", async () => {
    const asked: string[] = [];
    const resolve = async (host: string) => (asked.push(host), [{ address: "127.0.0.1", family: 4 }]);
    await withProxy({ resolve, exempt: [`127.0.0.1:${fx.sitePort}`] }, async (proxy) => {
      const r = await forward(proxy, `http://site.test:${fx.sitePort}/next`);
      expect(r.status).toBe(200);
      expect(r.body).toContain("Second page");
      // Resolved once, by the proxy; the socket went to that answer, so a second DNS answer cannot swap in another address.
      expect(asked).toEqual(["site.test"]);
    });
  });

  it("refuses loopback, private and metadata addresses, as literals or through DNS", async () => {
    const dns: Record<string, string[]> = { "intranet.test": ["10.0.0.5"], "mixed.test": ["93.184.216.34", "192.168.1.1"], "metadata.test": ["169.254.169.254"] };
    const resolve = async (host: string) => (dns[host] ?? []).map((address) => ({ address, family: 4 }));
    await withProxy({ resolve, exempt: [`127.0.0.1:${fx.sitePort}`] }, async (proxy) => {
      expect((await forward(proxy, `${fx.internal}/direct`)).status).toBe(403);
      expect((await forward(proxy, "http://intranet.test/")).status).toBe(403);
      expect((await forward(proxy, "http://mixed.test/")).status).toBe(403);
      expect((await forward(proxy, "http://metadata.test/latest/meta-data/")).status).toBe(403);
      expect((await forward(proxy, "http://[::ffff:127.0.0.1]/")).status).toBe(403);
      expect(await tunnel(proxy, `127.0.0.1:${new URL(fx.internal).port}`)).toBe(403);
      expect(await tunnel(proxy, "[::1]:443")).toBe(403);
      expect(await tunnel(proxy, "intranet.test:443")).toBe(403);
      expect(proxy.refused).toEqual(expect.arrayContaining([`127.0.0.1:${new URL(fx.internal).port}`, "intranet.test:80", "intranet.test:443", "mixed.test:80", "metadata.test:80", "[::1]:443"]));
    });
    expect(fx.internalHits).toEqual([]);
  });

  it("refuses ports other than 80 and 443, before it connects anywhere", async () => {
    const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
    await withProxy({ resolve }, async (proxy) => {
      expect((await forward(proxy, "http://shop.test:8080/")).status).toBe(403);
      expect(await tunnel(proxy, "shop.test:22")).toBe(403);
    });
  });

  it("refuses a host that does not resolve", async () => {
    await withProxy({ resolve: async () => [] }, async (proxy) => {
      expect((await forward(proxy, "http://nowhere.test/")).status).toBe(403);
    });
  });

  it("refuses everything when it is the deny-all backstop", async () => {
    await withProxy({ denyAll: true, exempt: [`127.0.0.1:${fx.sitePort}`] }, async (proxy) => {
      expect((await forward(proxy, `${fx.site}/`)).status).toBe(403);
    });
  });
});
