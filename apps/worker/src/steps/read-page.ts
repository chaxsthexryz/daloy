import { runs, stepRuns, workflowVersions, type Db } from "@daloy/db";
import { StepError } from "@daloy/engine";
import { and, desc, eq, ne } from "drizzle-orm";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { httpRequest, type HttpOptions } from "./http";
import { checkUrl, SsrfError, type SsrfGuard } from "./ssrf";

/** The read_page step (phase B1, decision 0107): one public page, read politely through the same guarded request as the http step. */
export type ReadPageInput = { url: string; selector?: string | undefined; maxChars: number };
export type PageContent = { title: string; text: string; value: string };

export const PAGE_MAX_BYTES = 2_000_000;
const ROBOTS_MAX_BYTES = 500_000;
const BOT_TOKEN = "DaloyBot";

/** The user agent, which names the bot and points at a page that says who runs it. */
export const botAgent = (publicUrl: string) => `${BOT_TOKEN}/1 (+${publicUrl.replace(/\/+$/, "")}/bot)`;

/** What a mocked test run returns: a fixed page, so the builder can run a condition on value, and no request leaves the machine. */
export const SAMPLE_PAGE: PageContent = {
  title: "Sample supplier page",
  text: "Jasmine rice 25 kg\nPrice: PHP 1,250.00\nIn stock",
  value: "PHP 1,250.00",
};

const BLOCKS = "p,div,li,h1,h2,h3,h4,h5,h6,tr,br,section,article,ul,ol,table,blockquote,pre,header,aside,form,dd,dt";
const NOT_TEXT = "script,style,noscript,template,svg,nav,footer";
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Title, main text (without script, style, nav and footer, cut to maxChars) and the text of the selector's first match. */
export function extractPage(html: string, { selector, maxChars }: { selector?: string | undefined; maxChars: number }): PageContent {
  const $ = cheerio.load(html);
  const title = collapse($("title").first().text());

  // The selector runs on the whole page: a price may sit in a header or a footer that the main text leaves out.
  let picked: string | undefined;
  if (selector !== undefined) {
    let found;
    try {
      found = $(selector).first();
    } catch {
      throw new StepError(`the selector ${JSON.stringify(selector)} is not valid CSS`, false);
    }
    // A broken selector must fail here: an empty value would look like a price change on the next run.
    if (found.length === 0) throw new StepError(`no element matches ${JSON.stringify(selector)} on the page, so it may have changed`, false);
    picked = collapse(found.text());
  }

  $(NOT_TEXT).remove();
  $(BLOCKS).after("\n");
  const main = $("main").first();
  const root = main.length ? main : $("body");
  const text = root
    .text()
    .split("\n")
    .map(collapse)
    .filter(Boolean)
    .join("\n")
    .slice(0, maxChars);
  return { title, text, value: picked === undefined ? text : picked.slice(0, maxChars) };
}

/** False when robots.txt asks DaloyBot (or all bots) to stay away from the page. */
export function robotsAllow(robotsTxt: string, pageUrl: string): boolean {
  return robotsParser(new URL("/robots.txt", pageUrl).href, robotsTxt).isAllowed(pageUrl, BOT_TOKEN) !== false;
}

type ReadOptions = {
  guard: SsrfGuard;
  publicUrl: string;
  idempotencyKey: string;
  /** Counts one web request against the daily cap. Called after the robots check and before the page is fetched. */
  claim?: (() => Promise<void>) | undefined;
  claimSend?: HttpOptions["claim"];
};

async function robotsTxt(url: URL, headers: Record<string, string>, key: string, opts: ReadOptions): Promise<string> {
  try {
    const out = await httpRequest({ method: "GET", url: new URL("/robots.txt", url).href, headers }, key, { guard: opts.guard, maxBytes: ROBOTS_MAX_BYTES, claim: opts.claimSend });
    return typeof out.body === "string" ? out.body : "";
  } catch (err) {
    if (!(err instanceof StepError)) throw err;
    // No robots.txt (404, 403 and the like) means no rules (RFC 9309). A server error, a timeout or a refused address is not
    // an answer, so the page is not read: staying away is the polite choice, and a server error is retried.
    if (err.outcome === "rejected" && /^HTTP 4\d\d/.test(err.message)) return "";
    if (err instanceof SsrfError) throw err;
    throw new StepError(`could not read robots.txt: ${err.message}`, err.retryable, { cause: err, outcome: err.outcome });
  }
}

/** Checks robots.txt for DaloyBot on the target URL's origin and throws a StepError if disallowed or unreadable. */
export async function checkPageRobots(url: URL, publicUrl: string, guard: SsrfGuard, idempotencyKey: string, claimSend?: HttpOptions["claim"]) {
  const headers = { "User-Agent": botAgent(publicUrl), Accept: "text/plain" };
  const rules = await robotsTxt(url, headers, idempotencyKey, { guard, publicUrl, idempotencyKey, claimSend });
  if (!robotsAllow(rules, url.href)) throw new StepError("the site asks bots not to read this page", false);
}

/** Reads the page. Throws a StepError with a plain message when it must not, cannot or should not be read. */
export async function readPage(cfg: ReadPageInput, opts: ReadOptions): Promise<PageContent> {
  const url = checkUrl(cfg.url, opts.guard);
  const headers = { "User-Agent": botAgent(opts.publicUrl) };
  await checkPageRobots(url, opts.publicUrl, opts.guard, opts.idempotencyKey, opts.claimSend);

  await opts.claim?.();
  const page = await httpRequest({ method: "GET", url: url.href, headers: { ...headers, Accept: "text/html,text/plain;q=0.9" } }, opts.idempotencyKey, {
    guard: opts.guard,
    maxBytes: PAGE_MAX_BYTES,
    claim: opts.claimSend,
  });
  const type = String(page.headers["content-type"] ?? "").toLowerCase();
  if (!/^(text\/|application\/xhtml\+xml)/.test(type) || typeof page.body !== "string") {
    throw new StepError(`this step only reads web pages and text, but the address answered with ${type.split(";")[0] || "no content type"}`, false);
  }
  return extractPage(page.body, cfg);
}

/** The value this step produced in this workflow's last successful real run, or null when there is none. */
export async function previousValue(db: Db, q: { workflowId: string; stepId: string; runId: string }): Promise<string | null> {
  const [row] = await db
    .select({ output: stepRuns.output })
    .from(stepRuns)
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .where(and(eq(workflowVersions.workflowId, q.workflowId), eq(stepRuns.stepId, q.stepId), eq(stepRuns.state, "succeeded"), eq(runs.test, false), ne(stepRuns.runId, q.runId)))
    .orderBy(desc(stepRuns.createdAt))
    .limit(1);
  const value = (row?.output as { value?: unknown } | null | undefined)?.value;
  return typeof value === "string" ? value : null;
}
