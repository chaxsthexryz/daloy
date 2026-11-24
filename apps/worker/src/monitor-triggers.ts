import { randomUUID } from "node:crypto";
import {
  MonitorPollError,
  pollMonitorTriggers,
  QuotaError,
  type Db,
  type FeedItem,
  type MonitorCursor,
  type MonitorFetchResult,
  type PageChangedTrigger,
} from "@daloy/db";
import { StepError } from "@daloy/engine";
import * as cheerio from "cheerio";
import { httpRequest } from "./steps/http";
import { botAgent, checkPageRobots, extractPage, PAGE_MAX_BYTES } from "./steps/read-page";
import { checkUrl, defaultGuard, SsrfError, type SsrfGuard } from "./steps/ssrf";

/**
 * G4 (decision 0133): Worker-side public web page and RSS/Atom feed monitor, reusing `read_page`'s SSRF guard,
 * robots.txt check, HTTP response cap, and daily HTTP quota.
 */

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function stripHtml(raw: string, maxChars: number): string {
  if (!raw) return "";
  const $ = cheerio.load(raw);
  return collapse($.text()).slice(0, maxChars);
}

function headerText(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value[0]?.trim()) return value[0].trim();
  return undefined;
}

/** Parses RSS 2.0 (<rss>/<channel>/<item>) or Atom (<feed>/<entry>) XML safely with cheerio. */
export function parseFeed(xml: string, maxChars: number): { feedTitle: string; items: FeedItem[] } {
  const $ = cheerio.load(xml, { xml: true });
  const isAtom = $("feed").length > 0 && $("feed > entry").length >= 0 && $("rss").length === 0;
  if (isAtom) {
    const feedTitle = collapse($("feed > title").first().text()).slice(0, 300);
    const items: FeedItem[] = [];
    $("feed > entry").each((_, el) => {
      if (items.length >= 50) return;
      const node = $(el);
      const title = collapse(node.children("title").first().text()).slice(0, 500);
      const linkEl = node.children("link[rel='alternate']").first().length ? node.children("link[rel='alternate']").first() : node.children("link").first();
      const link = (linkEl.attr("href") ?? collapse(linkEl.text())).trim().slice(0, 2000);
      const published = collapse(node.children("published").first().text() || node.children("updated").first().text()).slice(0, 100);
      const rawSummary = node.children("summary").first().text() || node.children("content").first().text();
      const summary = stripHtml(rawSummary, maxChars);
      const author = collapse(node.children("author").children("name").first().text() || node.children("author").first().text()).slice(0, 200);
      const rawId = collapse(node.children("id").first().text()).slice(0, 500);
      const itemId = rawId || link || `${title}|${published}|${summary.slice(0, 120)}`;
      if (itemId) items.push({ itemId, title, link, summary, published, author });
    });
    return { feedTitle, items };
  }

  const channel = $("rss > channel").first();
  if (channel.length === 0 && $("item").length === 0) {
    throw new MonitorPollError("the address did not return an RSS or Atom feed", false);
  }
  const feedTitle = collapse(channel.children("title").first().text()).slice(0, 300);
  const itemNodes = channel.length ? channel.children("item") : $("item");
  const items: FeedItem[] = [];
  itemNodes.each((_, el) => {
    if (items.length >= 50) return;
    const node = $(el);
    const title = collapse(node.children("title").first().text()).slice(0, 500);
    const link = collapse(node.children("link").first().text()).slice(0, 2000);
    const published = collapse(node.children("pubDate").first().text() || node.children("dc\\:date").first().text()).slice(0, 100);
    const rawSummary = node.children("description").first().text() || node.children("content\\:encoded").first().text();
    const summary = stripHtml(rawSummary, maxChars);
    const author = collapse(node.children("author").first().text() || node.children("dc\\:creator").first().text()).slice(0, 200);
    const rawId = collapse(node.children("guid").first().text()).slice(0, 500);
    const itemId = rawId || link || `${title}|${published}|${summary.slice(0, 120)}`;
    if (itemId) items.push({ itemId, title, link, summary, published, author });
  });
  return { feedTitle, items };
}

export async function fetchMonitorTarget(input: {
  trigger: PageChangedTrigger;
  cursor: MonitorCursor | null;
  claimHttp: () => Promise<void>;
  guard: SsrfGuard;
  publicUrl: string;
}): Promise<MonitorFetchResult> {
  const { trigger, cursor, guard, publicUrl } = input;
  const key = `monitor:${randomUUID()}`;
  try {
    const url = checkUrl(trigger.config.url, guard);
    await checkPageRobots(url, publicUrl, guard, key);
    await input.claimHttp();

    const headers: Record<string, string> = {
      "User-Agent": botAgent(publicUrl),
      Accept:
        trigger.config.mode === "feed"
          ? "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.1"
          : "text/html,application/xhtml+xml,text/plain;q=0.9",
    };
    if (cursor?.etag) headers["If-None-Match"] = cursor.etag;
    if (cursor?.lastModified) headers["If-Modified-Since"] = cursor.lastModified;

    const res = await httpRequest({ method: "GET", url: url.href, headers }, key, {
      guard,
      maxBytes: PAGE_MAX_BYTES,
    });
    const etag = headerText(res.headers.etag);
    const lastModified = headerText(res.headers["last-modified"]);
    if (res.status === 304) {
      return { kind: "not_modified", ...(etag && { etag }), ...(lastModified && { lastModified }) };
    }
    const type = String(res.headers["content-type"] ?? "").toLowerCase();
    if (typeof res.body !== "string") {
      throw new MonitorPollError(`the address answered with ${type.split(";")[0] || "non-text content"}`, false);
    }
    if (trigger.config.mode === "feed") {
      if (!/^(application\/(rss\+xml|atom\+xml|xml|xhtml\+xml)|text\/(xml|plain|html))/.test(type)) {
        throw new MonitorPollError(`expected an RSS or Atom feed, but got ${type.split(";")[0] || "no content type"}`, false);
      }
      const parsed = parseFeed(res.body, trigger.config.maxChars);
      return { kind: "feed", ...parsed, ...(etag && { etag }), ...(lastModified && { lastModified }) };
    }
    if (!/^(text\/|application\/xhtml\+xml)/.test(type)) {
      throw new MonitorPollError(`this monitor only reads web pages and text, but the address answered with ${type.split(";")[0] || "no content type"}`, false);
    }
    const page = extractPage(res.body, { selector: trigger.config.selector, maxChars: trigger.config.maxChars });
    return { kind: "page", ...page, ...(etag && { etag }), ...(lastModified && { lastModified }) };
  } catch (err) {
    if (err instanceof QuotaError || err instanceof MonitorPollError) throw err;
    if (err instanceof SsrfError) throw new MonitorPollError(err.message, false);
    if (err instanceof StepError) throw new MonitorPollError(err.message, err.retryable, err.retryAfterMs);
    throw err;
  }
}

export type WebMonitorPollOptions = {
  db: Db;
  publicUrl?: string;
  guard?: SsrfGuard;
  enqueue: (runId: string) => Promise<void>;
  limit?: number;
  intervalMs?: number;
};

export function pollWebMonitors(opts: WebMonitorPollOptions): Promise<number> {
  const guard = opts.guard ?? defaultGuard();
  const publicUrl = opts.publicUrl ?? "http://localhost:3000";
  return pollMonitorTriggers({
    db: opts.db,
    enqueue: opts.enqueue,
    limit: opts.limit,
    intervalMs: opts.intervalMs,
    fetchMonitor: ({ trigger, cursor, claimHttp }) =>
      fetchMonitorTarget({ trigger, cursor, claimHttp, guard, publicUrl }),
  });
}
