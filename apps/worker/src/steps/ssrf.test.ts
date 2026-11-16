import { describe, expect, it } from "vitest";
import { allowedHosts, blockListOf, checkUrl, defaultGuard, guardedLookup, isBlocked, SsrfError, type SsrfGuard } from "./ssrf";

const list = blockListOf();

describe("isBlocked", () => {
  it("blocks private, loopback, link-local, metadata and reserved IPv4 ranges", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.8",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlocked(ip, list), ip).toBe(true);
    }
  });

  it("blocks the IPv6 equivalents and IPv4-mapped addresses", () => {
    for (const ip of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "64:ff9b::7f00:1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1"]) {
      expect(isBlocked(ip, list), ip).toBe(true);
    }
  });

  it("allows public addresses and treats anything unparseable as blocked", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isBlocked(ip, list), ip).toBe(false);
    expect(isBlocked("not-an-ip", list)).toBe(true);
  });
});

describe("checkUrl", () => {
  const guard = defaultGuard();

  it("allows http and https on ports 80 and 443", () => {
    for (const url of ["https://example.com/a?b=1", "http://example.com", "http://example.com:80/", "https://example.com:443/", "http://example.com:443/"]) {
      expect(() => checkUrl(url, guard), url).not.toThrow();
    }
  });

  it("rejects other schemes, other ports and invalid URLs", () => {
    for (const url of ["ftp://example.com", "file:///etc/passwd", "gopher://example.com", "http://example.com:8080", "https://example.com:22", "not a url", ""]) {
      expect(() => checkUrl(url, guard), url).toThrow(SsrfError);
    }
  });

  it("rejects blocked IP literals in every spelling the URL parser accepts", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://0177.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fe80::1]/",
      "http://0/",
    ]) {
      expect(() => checkUrl(url, guard), url).toThrow(SsrfError);
    }
  });

  it("marks SSRF errors as not retryable", () => {
    expect(() => checkUrl("http://10.0.0.1/", guard)).toThrow(expect.objectContaining({ retryable: false }));
  });
});

describe("allowed hosts (HTTP_ALLOWED_HOSTS)", () => {
  const guard = { ...defaultGuard(), allowHosts: allowedHosts(" API.example.com, *.hooks.example.org ,,") };

  it("reads a comma list, ignoring case, spaces and empty entries", () => {
    expect(guard.allowHosts).toEqual(["api.example.com", "*.hooks.example.org"]);
    expect(allowedHosts("")).toBeUndefined();
    expect(allowedHosts(undefined)).toBeUndefined();
  });

  it("allows listed hosts and subdomains of a wildcard entry", () => {
    for (const url of ["https://api.example.com/x", "https://API.EXAMPLE.COM", "https://a.hooks.example.org", "https://b.a.hooks.example.org/y"]) {
      expect(() => checkUrl(url, guard), url).not.toThrow();
    }
  });

  it("refuses every other host, including look-alikes and IP literals", () => {
    for (const url of ["https://example.com", "https://hooks.example.org", "https://api.example.com.evil.test", "https://evilhooks.example.org", "http://93.184.216.34/"]) {
      expect(() => checkUrl(url, guard), url).toThrow(/not in HTTP_ALLOWED_HOSTS/);
    }
  });

  it("allows any public host when the list is empty", () => {
    expect(() => checkUrl("https://example.com", defaultGuard())).not.toThrow();
  });
});

describe("guardedLookup", () => {
  const guardWith = (addrs: string[]): SsrfGuard => ({
    ...defaultGuard(),
    resolve: async () => addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  });
  const lookup = (guard: SsrfGuard, all: boolean) =>
    new Promise<unknown>((resolve, reject) => {
      guardedLookup(guard)("host.test", { all }, (err: Error | null, address: unknown) => (err ? reject(err) : resolve(address)));
    });

  it("passes through a public address", async () => {
    expect(await lookup(guardWith(["93.184.215.14"]), false)).toBe("93.184.215.14");
    expect(await lookup(guardWith(["93.184.215.14", "2606:2800::1"]), true)).toEqual([
      { address: "93.184.215.14", family: 4 },
      { address: "2606:2800::1", family: 6 },
    ]);
  });

  it("rejects a hostname if any of its addresses is blocked", async () => {
    await expect(lookup(guardWith(["10.0.0.5"]), false)).rejects.toBeInstanceOf(SsrfError);
    await expect(lookup(guardWith(["93.184.215.14", "127.0.0.1"]), true)).rejects.toBeInstanceOf(SsrfError);
    await expect(lookup(guardWith([]), false)).rejects.toThrow();
  });
});
