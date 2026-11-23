import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { browserActionsSchema, refusedFillField, refusedFillValue, type BrowserAction } from "@daloy/engine";
import { chromium, errors, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import * as z from "zod";
import { startProxy, type Proxy, type ProxyOptions } from "./proxy";

/**
 * The browser service (phase B2, decision 0108). The worker is its only caller, over the internal Docker network, with
 * BROWSER_TOKEN. Every job gets a fresh browser context and its own guarded proxy, both closed when the job ends.
 *
 *   POST /run                 an action list, start to finish (the browser step)
 *   POST /sessions            open a page and keep it, for the B3 agent; answers with an aria snapshot
 *   GET  /sessions/:id/snapshot
 *   POST /sessions/:id/act    click or fill one element by its snapshot ref
 *   DELETE /sessions/:id
 */
export type ServiceOptions = {
  token: string;
  /** Jobs and sessions open at once (BROWSER_CONCURRENCY). One more answers 503. */
  concurrency: number;
  /** A run's time limit, and a session's idle limit. */
  jobMs: number;
  /** A session's total limit. */
  sessionMs?: number;
  proxy?: Omit<ProxyOptions, "denyAll">;
};
export type Service = { server: Server; close: () => Promise<void> };

const SNAPSHOT_MAX = 40_000;
const EXTRACT_MAX = 5000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// http(s) only, no user:password@ in the address. The proxy checks where it points.
const pageUrl = z
  .string()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "use an http:// or https:// address without a user name or password");
const runBody = z.strictObject({
  url: pageUrl,
  actions: browserActionsSchema.refine((list) => list.every((a) => a.action !== "goto" || pageUrl.safeParse(a.url).success), "every goto needs an http:// or https:// address"),
  /** How long one action may wait for its element. */
  timeoutMs: z.number().int().min(500).max(30_000).default(10_000),
});
const actBody = z.strictObject({ ref: z.string().regex(/^[a-z0-9]{1,16}$/i), action: z.enum(["click", "fill"]), value: z.string().max(2000).optional() });

// Passkeys always fail, the same way nod turns them off: the page sees a plain "not allowed".
const NO_PASSKEYS = `(() => {
  const c = window.CredentialsContainer && CredentialsContainer.prototype;
  if (!c) return;
  const no = () => Promise.reject(new DOMException("Passkeys are turned off in this browser.", "NotAllowedError"));
  const { get, create } = c;
  c.get = function (o) { return o && o.publicKey ? no() : get.call(this, o); };
  c.create = function (o) { return o && o.publicKey ? no() : create.call(this, o); };
})();`;

type Job = { context: BrowserContext; page: Page; proxy: Proxy };

export async function createService(opts: ServiceOptions): Promise<Service> {
  const expected = createHash("sha256").update(opts.token).digest();
  // The launch-level proxy refuses everything. Each context replaces it with its own job proxy, so a context opened
  // without one still reaches nothing.
  const backstop = await startProxy({ denyAll: true });
  const launch = () =>
    chromium.launch({
      proxy: { server: backstop.url },
      args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-background-networking"],
    });
  let browser: Promise<Browser> = launch();
  let active = 0;
  const sessions = new Map<string, Job & { idle?: NodeJS.Timeout; total: NodeJS.Timeout }>();

  async function open(): Promise<Job> {
    if (active >= opts.concurrency) throw new HttpError(503, "The browser is busy. Try again in a minute.");
    active++;
    let proxy: Proxy | undefined;
    try {
      let b = await browser;
      if (!b.isConnected()) b = await (browser = launch());
      proxy = await startProxy(opts.proxy);
      const context = await b.newContext({ proxy: { server: proxy.url }, acceptDownloads: false, serviceWorkers: "block", viewport: { width: 1280, height: 800 }, locale: "en-PH", timezoneId: "Asia/Manila" });
      await context.addInitScript(NO_PASSKEYS);
      // A second check behind the proxy: only http(s) requests leave the page.
      await context.route("**", (route) => (/^https?:$/.test(new URL(route.request().url()).protocol) ? route.continue() : route.abort("blockedbyclient")));
      // Listening takes over the file chooser, so no picker opens. Nothing ever answers it.
      context.on("page", (p) => p.on("filechooser", () => {}));
      const page = await context.newPage();
      return { context, page, proxy };
    } catch (err) {
      active--;
      await proxy?.close();
      throw err;
    }
  }
  async function close(job: Job) {
    await job.context.close().catch(() => {});
    await job.proxy.close();
    active--;
  }

  /** Throws when the page ended up on an address the proxy refused, such as after a redirect to 127.0.0.1. */
  function checkLanded(job: Job, err?: unknown) {
    let here = "";
    try {
      const u = new URL(job.page.url());
      here = `${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`;
    } catch {
      /* about:blank */
    }
    const last = job.proxy.refused.at(-1);
    if (last && (job.proxy.refused.includes(here) || err)) throw new HttpError(422, `Daloy refused to open ${last}: it is a private or blocked address, or not on port 80 or 443.`, { refused: job.proxy.refused });
    if (err) throw err;
  }

  async function goto(job: Job, url: string) {
    await job.page.goto(url, { waitUntil: "domcontentloaded" }).then(
      () => checkLanded(job),
      (err: unknown) => checkLanded(job, err),
    );
  }

  /** Types only after the element and the value both pass the password and card checks. */
  async function fill(loc: Locator, value: string) {
    const el = await loc.evaluate((e) => ({ type: (e as HTMLInputElement).type ?? "", autocomplete: e.getAttribute("autocomplete") ?? "", name: e.getAttribute("name") ?? "", id: e.id }));
    const refused = refusedFillField(el) ?? refusedFillValue(value);
    if (refused) throw new HttpError(422, refused, { refusedField: true });
    await loc.fill(value);
  }

  async function act(job: Job, a: BrowserAction, out: { extracted: Record<string, string>; screenshots: string[] }) {
    const { page } = job;
    switch (a.action) {
      case "goto":
        return goto(job, a.url);
      case "click":
        await (a.selector === undefined ? page.getByText(a.text!) : page.locator(a.selector)).first().click();
        await page.waitForLoadState("domcontentloaded");
        return checkLanded(job);
      case "fill":
        return fill(page.locator(a.selector).first(), a.value);
      case "wait":
        return void (await page.locator(a.selector).first().waitFor({ state: "visible" }));
      case "extract": {
        const loc = page.locator(a.selector).first();
        const text = await loc.evaluate((e) => (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement ? e.value : (e as HTMLElement).innerText));
        out.extracted[a.name] = text.trim().slice(0, EXTRACT_MAX);
        return;
      }
      case "screenshot":
        out.screenshots.push((await page.screenshot({ type: "png" })).toString("base64"));
    }
  }

  async function run(body: z.output<typeof runBody>) {
    const job = await open();
    job.context.setDefaultTimeout(body.timeoutMs);
    job.context.setDefaultNavigationTimeout(30_000);
    const out = { extracted: {} as Record<string, string>, screenshots: [] as string[] };
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new HttpError(504, `The page took longer than ${Math.round(opts.jobMs / 1000)} seconds.`));
        void job.context.close().catch(() => {});
      }, opts.jobMs);
    });
    const work = async () => {
      await goto(job, body.url);
      for (const [i, a] of body.actions.entries()) {
        try {
          await act(job, a, out);
        } catch (err) {
          if (err instanceof HttpError) throw err;
          const what = a.action === "click" && a.selector === undefined ? `the text "${a.text}"` : "selector" in a ? a.selector : a.action;
          const why = err instanceof errors.TimeoutError ? `could not find ${what} in time` : `failed on ${what}: ${firstLine(err)}`;
          throw new HttpError(422, `Action ${i + 1} (${a.action}) ${why}.`, { refused: job.proxy.refused });
        }
      }
      return { url: job.page.url(), ...out, refused: job.proxy.refused };
    };
    try {
      return await Promise.race([work(), deadline]);
    } finally {
      clearTimeout(timer);
      await close(job);
    }
  }

  async function snapshot(job: Job) {
    const text = await job.page.ariaSnapshot({ mode: "ai" });
    return { url: job.page.url(), title: await job.page.title(), snapshot: text.slice(0, SNAPSHOT_MAX), refused: job.proxy.refused };
  }
  function session(id: string) {
    const s = sessions.get(id);
    if (!s) throw new HttpError(404, "No such session. It may have timed out.");
    clearTimeout(s.idle);
    s.idle = setTimeout(() => void endSession(id), opts.jobMs);
    return s;
  }
  async function endSession(id: string) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    clearTimeout(s.idle);
    clearTimeout(s.total);
    await close(s);
  }

  async function route(req: IncomingMessage): Promise<[number, unknown]> {
    const path = (req.url ?? "/").split("?")[0]!;
    if (req.method === "GET" && path === "/health") return [200, { ok: true }];
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!timingSafeEqual(createHash("sha256").update(given).digest(), expected)) throw new HttpError(401, "Wrong or missing token.");

    if (req.method === "POST" && path === "/run") return [200, await run(parse(runBody, await readJson(req)))];
    if (req.method === "POST" && path === "/sessions") {
      const { url } = parse(z.strictObject({ url: pageUrl }), await readJson(req));
      const job = await open();
      const id = randomUUID();
      sessions.set(id, { ...job, total: setTimeout(() => void endSession(id), opts.sessionMs ?? 5 * 60_000) });
      try {
        session(id);
        await goto(job, url);
        return [200, { id, ...(await snapshot(job)) }];
      } catch (err) {
        await endSession(id);
        throw err;
      }
    }
    const m = /^\/sessions\/([0-9a-f-]{36})(\/snapshot|\/act)?$/.exec(path);
    if (m) {
      const [, id, sub] = m as unknown as [string, string, string | undefined];
      if (req.method === "DELETE" && !sub) {
        session(id);
        await endSession(id);
        return [204, null];
      }
      if (req.method === "GET" && sub === "/snapshot") return [200, await snapshot(session(id))];
      if (req.method === "POST" && sub === "/act") {
        const body = parse(actBody, await readJson(req));
        const s = session(id);
        // A ref names an element in the latest snapshot of its frame.
        const loc = s.page.getByRef(body.ref);
        if (body.action === "fill") await fill(loc, body.value ?? "");
        else {
          await loc.click({ timeout: 10_000 });
          await s.page.waitForLoadState("domcontentloaded");
          checkLanded(s);
        }
        return [200, await snapshot(s)];
      }
    }
    throw new HttpError(404, "Not found.");
  }

  const server = createServer((req, res: ServerResponse) => {
    route(req).then(
      ([status, body]) => send(res, status, body),
      (err: unknown) => {
        if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
        send(res, 500, { error: `The browser failed: ${firstLine(err)}` });
      },
    );
  });

  return {
    server,
    close: async () => {
      for (const id of [...sessions.keys()]) await endSession(id);
      await new Promise<void>((ok) => (server.listening ? server.close(() => ok()) : ok()));
      await (await browser).close();
      await backstop.close();
    },
  };
}

const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300);

function send(res: ServerResponse, status: number, body: unknown) {
  if (status === 204) return res.writeHead(204).end();
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > 256 * 1024) throw new HttpError(413, "The request is too large.");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "The body is not JSON.");
  }
}
