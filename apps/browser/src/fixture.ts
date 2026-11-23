import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Two local servers for the browser tests. "site" is the page under test, the one address the tests exempt from the
 * guard. "internal" stands for Postgres, the API or cloud metadata: the guard must keep every request away from it,
 * so the tests check that it saw none.
 */
export type Fixture = { site: string; internal: string; internalHits: string[]; sitePort: number; close: () => Promise<void> };

const html = (body: string) => `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;

export async function startFixture(): Promise<Fixture> {
  const internalHits: string[] = [];
  const internal = createServer((req, res) => {
    internalHits.push(`${req.method} ${req.url}`);
    res.end("internal secret");
  });
  internal.on("upgrade", (req, socket) => {
    internalHits.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  internal.on("connect", (req, socket) => {
    internalHits.push(`CONNECT ${req.url}`);
    socket.destroy();
  });
  await listen(internal);
  const internalUrl = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;

  const pages: Record<string, string> = {
    "/": html(`<h1>Supplier price list</h1>
      <p class="price">PHP 1,250.00</p>
      <a href="/next">Next page</a>
      <button id="reveal" onclick="document.getElementById('late').hidden=false">Show stock</button>
      <p id="late" hidden>12 in stock</p>
      <form><input name="q" autocomplete="off"><input name="pw" type="password"><input name="card" autocomplete="cc-number"><input name="otp" autocomplete="one-time-code"></form>
      <a href="/file.csv" download>Download</a>
      <input type="file" id="upload">`),
    "/next": html(`<h1>Second page</h1>`),
    "/redirect": "",
    "/iframe": html(`<h1>Frame host</h1><iframe src="${internalUrl}/from-iframe"></iframe>`),
    "/websocket": html(`<h1>Socket</h1><p id="ws">pending</p><script>
      const ws = new WebSocket("ws://${internalUrl.slice(7)}/from-ws");
      ws.onopen = () => document.getElementById("ws").textContent = "open";
      ws.onerror = () => document.getElementById("ws").textContent = "refused";
    </script>`),
    "/fetch": html(`<h1>Fetch</h1><p id="out">pending</p><script>
      fetch("${internalUrl}/from-fetch").then(() => out.textContent = "reached", () => out.textContent = "refused");
    </script>`),
    "/passkey": html(`<p id="pk">pending</p><script>
      navigator.credentials.get({ publicKey: { challenge: new Uint8Array(16) } }).then(() => pk.textContent = "used", (e) => pk.textContent = e.name);
    </script>`),
  };
  const site = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/redirect") return res.writeHead(302, { location: `${internalUrl}/from-redirect` }).end();
    if (path === "/file.csv") return res.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=file.csv" }).end("a,b\n");
    const page = pages[path];
    if (page === undefined) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  });
  await listen(site);
  const sitePort = (site.address() as AddressInfo).port;
  return {
    site: `http://127.0.0.1:${sitePort}`,
    sitePort,
    internal: internalUrl,
    internalHits,
    close: async () => {
      await Promise.all([site, internal].map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))));
    },
  };
}

const listen = (s: Server) => new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
