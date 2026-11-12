import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { StepError } from "@daloy/engine";

/** Addresses an HTTP step may never reach: private, loopback, link-local (cloud metadata), shared, reserved and multicast. */
export const BLOCKED_RANGES: [network: string, prefix: number, family: "ipv4" | "ipv6"][] = [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
];

export function blockListOf(ranges = BLOCKED_RANGES): BlockList {
  const list = new BlockList();
  for (const [net, prefix, family] of ranges) list.addSubnet(net, prefix, family);
  return list;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
/** Everything the SSRF checks depend on, injectable so tests can point at a local server and fake DNS. */
export type SsrfGuard = { blockList: BlockList; resolve: Resolver; ports: string[] };

export const defaultGuard = (): SsrfGuard => ({
  blockList: blockListOf(),
  resolve: (hostname) => dnsLookup(hostname, { all: true, order: "verbatim" }),
  // "" is the scheme's default port; URL drops ":80" on http and ":443" on https.
  ports: ["", "80", "443"],
});

export class SsrfError extends StepError {
  override name = "SsrfError";
  constructor(message: string) {
    super(message, false);
  }
}

/** BlockList also matches IPv4-mapped IPv6 (::ffff:a.b.c.d) against the IPv4 ranges. */
export function isBlocked(address: string, list: BlockList): boolean {
  const family = isIP(address);
  return family === 0 || list.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Checks scheme, port and IP-literal hosts. new URL() normalises forms such as http://2130706433 to 127.0.0.1 first.
 * Hostnames are checked later, in guardedLookup, because Node does not call lookup for IP literals.
 */
export function checkUrl(raw: string | URL, guard: SsrfGuard): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SsrfError(`scheme ${url.protocol} is not allowed`);
  if (!guard.ports.includes(url.port)) throw new SsrfError(`port ${url.port} is not allowed`);
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(host) && isBlocked(host, guard.blockList)) throw new SsrfError(`${host} is a blocked address`);
  return url;
}

/**
 * A DNS lookup for http.request that refuses blocked addresses. The socket connects to the address returned
 * here, so a second DNS answer (rebinding) can never swap in an address that was not checked.
 */
export function guardedLookup(guard: SsrfGuard): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (err: Error | null, address?: unknown, family?: number) => void) => {
    guard.resolve(hostname).then(
      (addrs) => {
        if (addrs.length === 0) return callback(new StepError(`${hostname} did not resolve`, true));
        if (addrs.some((a) => isBlocked(a.address, guard.blockList))) return callback(new SsrfError(`${hostname} resolves to a blocked address`));
        if (options.all) return callback(null, addrs);
        callback(null, addrs[0]!.address, addrs[0]!.family);
      },
      (err: Error) => callback(err),
    );
  }) as LookupFunction;
}
