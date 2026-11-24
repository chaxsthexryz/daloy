// Adapted from n8n nod, src/providers/agent-browser/network.ts (createBrowserProxy), Copyright 2026 n8n GmbH,
// Apache-2.0. Changed for kymavo: the address check uses @daloy/engine's BLOCKED_RANGES, ports are limited to 80 and
// 443, refusals are recorded per job, plain-http upgrades are dropped, and a deny-all mode backs up the launch.
// See NOTICE in this folder.
import { lookup } from "node:dns/promises";
import { createServer, request, type OutgoingHttpHeaders } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { BLOCKED_RANGES } from "@daloy/engine";

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export type ProxyOptions = {
  /** DNS for the checks. Tests pass a fake one. */
  resolve?: Resolver;
  /** "address:port" pairs allowed although private. Tests only, for the local fixture site; main.ts never sets it. */
  exempt?: string[];
  /** Refuses every request. The browser is launched with this one, so a context without its own proxy reaches nothing. */
  denyAll?: boolean;
};
export type Proxy = { url: string; /** host:port pairs refused during this job, in order. */ refused: string[]; close: () => Promise<void> };

const blockList = new BlockList();
for (const [net, prefix, family] of BLOCKED_RANGES) blockList.addSubnet(net, prefix, family);
// BlockList also matches IPv4-mapped IPv6 (::ffff:a.b.c.d) against the IPv4 ranges.
const blocked = (address: string) => isIP(address) === 0 || blockList.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
const systemResolve: Resolver = (host) => lookup(host, { all: true, order: "verbatim" });

class Refused extends Error {}

export async function startProxy(opts: ProxyOptions = {}): Promise<Proxy> {
  const resolve = opts.resolve ?? systemResolve;
  const exempt = new Set(opts.exempt ?? []);
  const refused: string[] = [];
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
    s.on("error", () => s.destroy());
  };

  /**
   * The one address the socket will connect to. Every answer for the host must be allowed, and the connection goes
   * to the first of them, so a second DNS answer (rebinding) can never swap in an address that was not checked.
   */
  async function destination(hostname: string, port: number): Promise<string> {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    try {
      if (opts.denyAll) throw new Refused();
      const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host).catch(() => []);
      if (answers.length === 0) throw new Refused();
      const ok = (a: string) => exempt.has(`${a}:${port}`) || (!blocked(a) && (port === 80 || port === 443));
      if (!answers.every((a) => ok(a.address))) throw new Refused();
      return answers[0]!.address;
    } catch (err) {
      refused.push(`${host.includes(":") ? `[${host}]` : host}:${port}`);
      throw err;
    }
  }

  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url ?? "");
      if (url.protocol !== "http:" || url.username || url.password) throw new Refused();
      const headers: OutgoingHttpHeaders = { ...incoming.headers, host: url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const port = Number(url.port || 80);
      const upstream = request({ host: await destination(url.hostname, port), port, method: incoming.method, path: url.pathname + url.search, headers }, (res) => {
        outgoing.writeHead(res.statusCode ?? 502, res.headers);
        res.pipe(outgoing);
      });
      upstream.on("socket", track);
      upstream.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    } catch {
      outgoing.writeHead(403, { "content-type": "text/plain" }).end("kymavo refused this address: it is private, blocked or not on port 80 or 443.");
    }
  });

  // https and WebSockets arrive as CONNECT host:port.
  server.on("connect", async (incoming, socket: Socket, head: Buffer) => {
    track(socket);
    try {
      const url = new URL(`https://${incoming.url ?? ""}`);
      if (url.pathname !== "/" || url.search || url.username) throw new Refused();
      const port = Number(url.port || 443);
      const upstream = connect({ host: await destination(url.hostname, port), port });
      track(upstream);
      upstream.on("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  // ponytail: a plain-http WebSocket upgrade sent without CONNECT is dropped, not forwarded. Chromium tunnels
  // WebSockets with CONNECT through a proxy, so this only fails closed. Forward it like nod does if a site needs it.
  server.on("upgrade", (_req, socket: Socket) => socket.destroy());
  server.on("connection", track);

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok());
  });
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    refused,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}
