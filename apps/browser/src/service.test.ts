import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFixture, type Fixture } from "./fixture";
import { createService, type Service } from "./service";

// Real Chromium against a local fixture site. Only the fixture's own address:port is exempt from the guard, and only
// here: main.ts never passes an exemption.
const TOKEN = "test-token-0123456789abcdef0123456789abcdef";
let fx: Fixture;
let svc: Service;
let base: string;

beforeAll(async () => {
  fx = await startFixture();
  svc = await createService({ token: TOKEN, concurrency: 2, jobMs: 30_000, proxy: { exempt: [`127.0.0.1:${fx.sitePort}`] } });
  await new Promise<void>((r) => svc.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(svc.server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  await svc?.close();
  await fx?.close();
});
beforeEach(() => {
  fx.internalHits.length = 0;
});

async function call(path: string, body?: unknown, opts: { method?: string; token?: string } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${opts.token ?? TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as Record<string, unknown>) };
}
const run = (url: string, actions: unknown[]) => call("/run", { url, actions });

describe("browser service", () => {
  it("answers health without a token and refuses anything else without the right one", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await call("/run", { url: fx.site, actions: [] }, { token: "wrong" })).status).toBe(401);
    expect((await fetch(`${base}/run`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("runs an action list: read, click by text, wait, fill, navigate, screenshot", async () => {
    const r = await run(fx.site, [
      { action: "extract", selector: ".price", name: "price" },
      { action: "click", text: "Show stock" },
      { action: "wait", selector: "#late" },
      { action: "extract", selector: "#late", name: "stock" },
      { action: "fill", selector: "input[name=q]", value: "Ana Reyes" },
      { action: "extract", selector: "input[name=q]", name: "typed" },
      { action: "click", selector: "a[href='/next']" },
      { action: "wait", selector: "h1" },
      { action: "screenshot" },
    ]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ url: `${fx.site}/next`, extracted: { price: "PHP 1,250.00", stock: "12 in stock", typed: "Ana Reyes" } });
    const shots = r.body!.screenshots as string[];
    expect(shots).toHaveLength(1);
    expect(Buffer.from(shots[0]!, "base64").subarray(1, 4).toString()).toBe("PNG");
  }, 60_000);

  it("never types into password, card or one-time code fields, nor a card number anywhere", async () => {
    for (const selector of ["input[name=pw]", "input[name=card]", "input[name=otp]"]) {
      const r = await run(fx.site, [{ action: "fill", selector, value: "hunter2" }]);
      expect(r.status).toBe(422);
      expect(r.body!.error).toMatch(/never types/);
    }
    const card = await run(fx.site, [{ action: "fill", selector: "input[name=q]", value: "4111 1111 1111 1111" }]);
    expect(card.status).toBe(422);
    expect(card.body!.error).toMatch(/card/);
  }, 60_000);

  it("refuses a redirect to 127.0.0.1", async () => {
    const r = await run(`${fx.site}/redirect`, []);
    expect(r.status).toBe(422);
    expect(r.body!.error).toMatch(/private or blocked address/);
    expect(r.body!.refused).toContain(`127.0.0.1:${new URL(fx.internal).port}`);
    expect(fx.internalHits).toEqual([]);
  }, 60_000);

  it("refuses an iframe, a fetch and a WebSocket aimed at 127.0.0.1, and the page still loads", async () => {
    const frame = await run(`${fx.site}/iframe`, [{ action: "extract", selector: "h1", name: "title" }]);
    expect(frame.status).toBe(200);
    expect(frame.body!.extracted).toEqual({ title: "Frame host" });
    expect(frame.body!.refused).toContain(`127.0.0.1:${new URL(fx.internal).port}`);

    const ws = await run(`${fx.site}/websocket`, [{ action: "wait", selector: "#ws:not(:has-text('pending'))" }, { action: "extract", selector: "#ws", name: "ws" }]);
    expect(ws.status).toBe(200);
    expect(ws.body!.extracted).toEqual({ ws: "refused" });

    const f = await run(`${fx.site}/fetch`, [{ action: "wait", selector: "#out:not(:has-text('pending'))" }, { action: "extract", selector: "#out", name: "out" }]);
    expect(f.body!.extracted).toEqual({ out: "refused" });
    expect(fx.internalHits).toEqual([]);
  }, 60_000);

  it("refuses a direct private address and non-http schemes", async () => {
    const direct = await run(`${fx.internal}/`, []);
    expect(direct.status).toBe(422);
    expect(fx.internalHits).toEqual([]);
    expect((await run("file:///etc/passwd", [])).status).toBe(400);
    expect((await run(fx.site, [{ action: "goto", url: "javascript:alert(1)" }])).status).toBe(400);
    expect((await run("http://user:pw@example.com/", [])).status).toBe(400);
  }, 60_000);

  it("blocks downloads and passkeys", async () => {
    const dl = await run(fx.site, [{ action: "click", text: "Download" }, { action: "extract", selector: "h1", name: "h" }]);
    expect(dl.status).toBe(200);
    expect(dl.body!.extracted).toEqual({ h: "Supplier price list" });
    const pk = await run(`${fx.site}/passkey`, [{ action: "wait", selector: "#pk:not(:has-text('pending'))" }, { action: "extract", selector: "#pk", name: "pk" }]);
    expect(pk.body!.extracted).toEqual({ pk: "NotAllowedError" });
  }, 60_000);

  it("names the selector it could not find", async () => {
    const r = await call("/run", { url: fx.site, actions: [{ action: "click", selector: "#missing" }], timeoutMs: 1500 });
    expect(r.status).toBe(422);
    expect(r.body!.error).toMatch(/#missing/);
  }, 60_000);
});

describe("sessions (for the B3 agent)", () => {
  it("opens a page, returns an aria snapshot with refs, and acts by ref", async () => {
    const open = await call("/sessions", { url: fx.site });
    expect(open.status).toBe(200);
    const id = open.body!.id as string;
    expect(open.body!.snapshot).toMatch(/link "Next page" \[ref=e\d+\]/);
    const ref = /link "Next page" \[ref=(e\d+)\]/.exec(open.body!.snapshot as string)![1];
    const pw = /textbox \[ref=(e\d+)\]/g;
    const refs = [...(open.body!.snapshot as string).matchAll(pw)].map((m) => m[1]!);

    // The second textbox is the password field: refused by ref as well.
    const fill = await call(`/sessions/${id}/act`, { ref: refs[1], action: "fill", value: "hunter2" });
    expect(fill.status).toBe(422);

    const act = await call(`/sessions/${id}/act`, { ref, action: "click" });
    expect(act.status).toBe(200);
    expect(act.body!.url).toBe(`${fx.site}/next`);
    expect(act.body!.snapshot).toContain("Second page");

    expect((await call(`/sessions/${id}/snapshot`)).body!.title).toBe("Fixture");
    expect((await call(`/sessions/${id}`, undefined, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/sessions/${id}/snapshot`)).status).toBe(404);
  }, 60_000);

  it("answers busy past BROWSER_CONCURRENCY", async () => {
    const a = await call("/sessions", { url: fx.site });
    const b = await call("/sessions", { url: fx.site });
    expect((await run(fx.site, [])).status).toBe(503);
    for (const s of [a, b]) await call(`/sessions/${s.body!.id}`, undefined, { method: "DELETE" });
    expect((await run(fx.site, [])).status).toBe(200);
  }, 60_000);
});

describe("job deadline", () => {
  it("ends a job past its time limit and frees the slot", async () => {
    const quick = await createService({ token: TOKEN, concurrency: 1, jobMs: 1500, proxy: { exempt: [`127.0.0.1:${fx.sitePort}`] } });
    await new Promise<void>((r) => quick.server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(quick.server.address() as AddressInfo).port}/run`;
    const post = (actions: unknown[]) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ url: fx.site, actions }) });
    try {
      const slow = await post([{ action: "wait", selector: "#never" }]);
      expect(slow.status).toBe(504);
      expect((await post([])).status).toBe(200);
    } finally {
      await quick.close();
    }
  }, 60_000);
});
