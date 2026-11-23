import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StepError } from "@daloy/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { botAgent, extractPage, readPage, robotsAllow } from "./read-page";
import { BLOCKED_RANGES, blockListOf, SsrfError, type SsrfGuard } from "./ssrf";

const PAGE = `<!doctype html><html><head><title>  Rice supplier &amp; co  </title><style>.x{color:red}</style><script>var secret = 1;</script></head>
<body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<main>
  <h1>Jasmine rice 25 kg</h1>
  <p>Fresh stock <b>every</b> week.</p>
  <p class="price">  ₱ 1,250.00  </p>
  <ul><li>Free delivery</li><li>Pay on pickup</li></ul>
  <script>alert("nope")</script>
</main>
<footer>Copyright Rice Co. Terms and privacy</footer>
</body></html>`;

describe("extractPage", () => {
  it("returns the title with entities decoded and spaces trimmed", () => {
    expect(extractPage(PAGE, { maxChars: 4000 }).title).toBe("Rice supplier & co");
  });

  it("drops script, style, nav and footer text and keeps blocks on separate lines", () => {
    const { text } = extractPage(PAGE, { maxChars: 4000 });
    expect(text).toBe("Jasmine rice 25 kg\nFresh stock every week.\n₱ 1,250.00\nFree delivery\nPay on pickup");
    for (const gone of ["secret", "alert", "color", "Home", "Copyright"]) expect(text).not.toContain(gone);
  });

  it("reads the whole body when the page has no main element", () => {
    const { text } = extractPage("<html><body><nav>menu</nav><div>One</div><div>Two</div><footer>f</footer></body></html>", { maxChars: 100 });
    expect(text).toBe("One\nTwo");
  });

  it("cuts the text to maxChars", () => {
    expect(extractPage(PAGE, { maxChars: 10 }).text).toBe("Jasmine ri");
  });

  it("returns the selector's text, trimmed, and the first match only", () => {
    expect(extractPage(PAGE, { selector: ".price", maxChars: 4000 }).value).toBe("₱ 1,250.00");
    expect(extractPage(PAGE, { selector: "li", maxChars: 4000 }).value).toBe("Free delivery");
  });

  it("finds a selector inside the nav or footer, which the text leaves out", () => {
    expect(extractPage(PAGE, { selector: "footer", maxChars: 4000 }).value).toBe("Copyright Rice Co. Terms and privacy");
  });

  it("uses the whole text as the value when there is no selector", () => {
    const out = extractPage(PAGE, { maxChars: 4000 });
    expect(out.value).toBe(out.text);
  });

  it("fails with a plain message when the selector matches nothing, so a broken selector never looks like a price change", () => {
    expect(() => extractPage(PAGE, { selector: ".nope", maxChars: 4000 })).toThrow(/no element matches ".nope"/i);
  });

  it("fails with a plain message when the selector is not valid CSS", () => {
    const err = (() => {
      try {
        extractPage(PAGE, { selector: "div[", maxChars: 4000 });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(StepError);
    expect((err as StepError).retryable).toBe(false);
    expect((err as StepError).message).toMatch(/selector/i);
  });
});

describe("robotsAllow", () => {
  const url = "https://shop.example/rice/jasmine";
  it("allows everything when the file is empty", () => expect(robotsAllow("", url)).toBe(true));
  it("blocks a path the star group disallows, and allows the others", () => {
    const txt = "User-agent: *\nDisallow: /private/\n";
    expect(robotsAllow(txt, "https://shop.example/private/prices")).toBe(false);
    expect(robotsAllow(txt, url)).toBe(true);
  });
  it("blocks the whole site for DaloyBot", () => expect(robotsAllow("User-agent: DaloyBot\nDisallow: /\n", url)).toBe(false));
  it("lets the DaloyBot group override the star group", () => {
    expect(robotsAllow("User-agent: *\nDisallow: /\n\nUser-agent: DaloyBot\nAllow: /\n", url)).toBe(true);
  });
  it("blocks when the star group disallows everything", () => expect(robotsAllow("User-agent: *\nDisallow: /\n", url)).toBe(false));
  it("honours an Allow that is longer than the Disallow", () => {
    expect(robotsAllow("User-agent: *\nDisallow: /rice\nAllow: /rice/jasmine\n", url)).toBe(true);
  });
});

describe("botAgent", () => {
  it("names the bot and points at the bot page of this installation", () => {
    expect(botAgent("https://daloy.example.com/")).toBe("DaloyBot/1 (+https://daloy.example.com/bot)");
  });
});

// A local server stands in for the supplier. Its host name resolves to 127.0.0.1, which the guard allows in this test only.
let server: Server;
let port: number;
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
let robots: { status: number; body: string } = { status: 404, body: "" };

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url!, headers: req.headers });
    const at = (p: string) => req.url!.startsWith(p);
    if (at("/robots.txt")) return res.writeHead(robots.status, { "content-type": "text/plain" }).end(robots.body);
    if (at("/rice")) return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    if (at("/plain")) return res.writeHead(200, { "content-type": "text/plain" }).end("Price today: 52 pesos");
    if (at("/data.json")) return res.writeHead(200, { "content-type": "application/json" }).end('{"price":52}');
    if (at("/image.png")) return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(100, 1));
    if (at("/huge")) return res.writeHead(200, { "content-type": "text/html" }).end(`<p>${"a".repeat(2_100_000)}</p>`);
    if (at("/to-private")) return res.writeHead(302, { location: "http://private.test/inside" }).end();
    if (at("/missing")) return res.writeHead(404).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const guard = (): SsrfGuard => ({
  blockList: blockListOf(BLOCKED_RANGES.filter(([net]) => net !== "127.0.0.0")),
  ports: ["", String(port)],
  resolve: async (host) => {
    if (host === "supplier.test") return [{ address: "127.0.0.1", family: 4 }];
    if (host === "private.test") return [{ address: "10.0.0.1", family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  },
});
const base = () => `http://supplier.test:${port}`;
const read = (path: string, extra: { selector?: string; maxChars?: number; claim?: () => Promise<void> } = {}) =>
  readPage({ url: base() + path, selector: extra.selector, maxChars: extra.maxChars ?? 4000 }, { guard: guard(), publicUrl: "https://daloy.example.com", idempotencyKey: "run:read", claim: extra.claim });
const failure = async (p: Promise<unknown>) => {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(StepError);
  return err as StepError;
};

describe("readPage against a local page", () => {
  it("reads the page, sends the DaloyBot user agent and checks robots.txt first", async () => {
    robots = { status: 404, body: "" };
    seen.length = 0;
    const out = await read("/rice", { selector: ".price" });
    expect(out).toMatchObject({ title: "Rice supplier & co", value: "₱ 1,250.00" });
    expect(out.text).toContain("Jasmine rice 25 kg");
    expect(seen.map((s) => s.url)).toEqual(["/robots.txt", "/rice"]);
    for (const s of seen) expect(s.headers["user-agent"]).toBe("DaloyBot/1 (+https://daloy.example.com/bot)");
  });

  it("reads plain text pages", async () => {
    const out = await read("/plain");
    expect(out.text).toBe("Price today: 52 pesos");
  });

  it("refuses with a plain message when robots.txt disallows the page, and sends no claim and no page request", async () => {
    robots = { status: 200, body: "User-agent: *\nDisallow: /rice\n" };
    seen.length = 0;
    let claimed = 0;
    const err = await failure(read("/rice", { claim: async () => void claimed++ }));
    expect(err.message).toBe("the site asks bots not to read this page");
    expect(err.retryable).toBe(false);
    expect(claimed).toBe(0);
    expect(seen.map((s) => s.url)).toEqual(["/robots.txt"]);
  });

  it("allows a page when robots.txt only blocks other paths", async () => {
    robots = { status: 200, body: "User-agent: *\nDisallow: /admin\n" };
    expect((await read("/plain")).text).toContain("52 pesos");
  });

  it("treats a 404 for robots.txt as no rules", async () => {
    robots = { status: 404, body: "" };
    expect((await read("/plain")).text).toContain("52 pesos");
  });

  it("fails, and can be retried, when robots.txt cannot be read because the site is erroring", async () => {
    robots = { status: 503, body: "" };
    const err = await failure(read("/plain"));
    expect(err.message).toMatch(/robots\.txt/);
    expect(err.retryable).toBe(true);
  });

  it("claims one web request, after the robots check", async () => {
    robots = { status: 404, body: "" };
    let claimed = 0;
    await read("/plain", { claim: async () => void claimed++ });
    expect(claimed).toBe(1);
  });

  it("refuses a page that is not HTML or text", async () => {
    robots = { status: 404, body: "" };
    for (const path of ["/data.json", "/image.png"]) expect((await failure(read(path))).message).toMatch(/not a web page|only reads web pages/i);
  });

  it("refuses a page over 2 MB", async () => {
    robots = { status: 404, body: "" };
    expect((await failure(read("/huge"))).message).toMatch(/larger than 2000000 bytes/);
  });

  it("explains a page that answers with an error", async () => {
    robots = { status: 404, body: "" };
    expect((await failure(read("/missing"))).message).toMatch(/HTTP 404/);
  });
});

describe("readPage keeps the SSRF guard", () => {
  it("refuses a private address before any request is made", async () => {
    const err = await failure(readPage({ url: "http://10.0.0.1/admin", maxChars: 100 }, { guard: guard(), publicUrl: "https://d.example", idempotencyKey: "k" }));
    expect(err).toBeInstanceOf(SsrfError);
  });

  it("refuses a host name that resolves to a private address", async () => {
    const err = await failure(readPage({ url: `http://private.test:${port}/x`, maxChars: 100 }, { guard: guard(), publicUrl: "https://d.example", idempotencyKey: "k" }));
    expect(err.message).toMatch(/not allowed|blocked|private/i);
  });

  it("refuses localhost and cloud metadata addresses under the default blocked ranges", async () => {
    const strict: SsrfGuard = { ...guard(), blockList: blockListOf() };
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/"]) {
      expect(await failure(readPage({ url, maxChars: 100 }, { guard: strict, publicUrl: "https://d.example", idempotencyKey: "k" }))).toBeInstanceOf(SsrfError);
    }
  });

  it("refuses a redirect that leads to a private address", async () => {
    robots = { status: 404, body: "" };
    const err = await failure(read("/to-private"));
    expect(err).toBeInstanceOf(StepError);
    expect(err.message).toMatch(/not allowed|blocked|private/i);
  });

  it("refuses non-web schemes", async () => {
    expect(await failure(readPage({ url: "file:///etc/passwd", maxChars: 100 }, { guard: guard(), publicUrl: "https://d.example", idempotencyKey: "k" }))).toBeInstanceOf(SsrfError);
  });
});
