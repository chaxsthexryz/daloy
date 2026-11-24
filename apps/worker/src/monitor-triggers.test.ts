import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { triggerPolls, triggers, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { parseFeed, pollWebMonitors } from "./monitor-triggers";
import { BLOCKED_RANGES, blockListOf, type SsrfGuard } from "./steps/ssrf";
import { startWorker, type Worker } from "./worker";

describe("parseFeed (RSS 2.0 and Atom)", () => {
  it("parses RSS 2.0 channel items and strips HTML from descriptions", () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel><title>Supplier Updates</title>
        <item>
          <guid>post-1</guid>
          <title>Rice price drop</title>
          <link>https://example.com/posts/1</link>
          <description><![CDATA[<p>Now <b>PHP 48</b> per kilo.</p>]]></description>
          <pubDate>Tue, 24 Nov 2026 08:00:00 GMT</pubDate>
        </item>
      </channel></rss>`;
    const parsed = parseFeed(rss, 2000);
    expect(parsed.feedTitle).toBe("Supplier Updates");
    expect(parsed.items).toEqual([
      {
        itemId: "post-1",
        title: "Rice price drop",
        link: "https://example.com/posts/1",
        summary: "Now PHP 48 per kilo.",
        published: "Tue, 24 Nov 2026 08:00:00 GMT",
        author: "",
      },
    ]);
  });

  it("parses Atom entries with alternate link and author", () => {
    const atom = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Releases</title>
        <entry>
          <id>urn:uuid:1234</id>
          <title>v2.0</title>
          <link rel="alternate" href="https://example.com/v2" />
          <updated>2026-11-24T09:00:00Z</updated>
          <author><name>Ana</name></author>
          <summary>Faster checkout</summary>
        </entry>
      </feed>`;
    const parsed = parseFeed(atom, 2000);
    expect(parsed.feedTitle).toBe("Releases");
    expect(parsed.items[0]).toEqual({
      itemId: "urn:uuid:1234",
      title: "v2.0",
      link: "https://example.com/v2",
      summary: "Faster checkout",
      published: "2026-11-24T09:00:00Z",
      author: "Ana",
    });
  });
});

describe("pollWebMonitors (real HTTP + SSRF guard + robots.txt + worker timer)", () => {
  let db: Db;
  let dbUrl: string;
  let pool: Pool;
  let server: Server;
  let port: number;
  let seq = 0;

  let price = "PHP 52.00";
  let etag = '"v1"';
  let feedItems = [{ id: "g1", title: "Old post" }];
  let robotsTxt = "";
  let pageRequests = 0;

  beforeAll(async () => {
    ({ url: dbUrl, db, pool } = await freshDatabase());
    server = createServer((req, res) => {
      if (req.url === "/robots.txt") {
        if (!robotsTxt) return res.writeHead(404).end();
        return res.writeHead(200, { "content-type": "text/plain" }).end(robotsTxt);
      }
      if (req.url === "/rice") {
        pageRequests++;
        if (req.headers["if-none-match"] === etag) {
          return res.writeHead(304, { etag }).end();
        }
        return res
          .writeHead(200, { "content-type": "text/html; charset=utf-8", etag })
          .end(`<html><head><title>Rice</title></head><body><span class="price">${price}</span></body></html>`);
      }
      if (req.url === "/feed.xml") {
        const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Shop</title>${feedItems
          .map((i) => `<item><guid>${i.id}</guid><title>${i.title}</title><link>https://shop.test/${i.id}</link></item>`)
          .join("")}</channel></rss>`;
        return res.writeHead(200, { "content-type": "application/rss+xml" }).end(xml);
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  }, 120_000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
    await pool?.end();
  });

  const localGuard = (): SsrfGuard => ({
    blockList: blockListOf(BLOCKED_RANGES.filter(([net]) => net !== "127.0.0.0")),
    ports: ["", String(port)],
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  });

  async function addMonitorWorkflow(config: Record<string, unknown>) {
    const [u] = await db.insert(users).values({ email: `wmon-${++seq}@test.local`, passwordHash: "x" }).returning();
    const [w] = await db.insert(workflows).values({ userId: u!.id, name: "Watch", slug: `wmon-${seq}` }).returning();
    await db.insert(workflowVersions).values({
      workflowId: w!.id,
      version: 1,
      definition: { trigger: { type: "page_changed", config }, steps: [{ id: "done", type: "delay", config: { seconds: 1 } }], edges: [] },
      published: true,
    });
    await db.insert(triggers).values({ workflowId: w!.id, type: "page_changed", config });
    return w!.id;
  }

  const due = (workflowId: string) => db.update(triggerPolls).set({ nextPollAt: sql`now()` }).where(eq(triggerPolls.workflowId, workflowId));
  const runsOf = async (workflowId: string) =>
    (await db.execute<{ id: string; state: string; trigger_payload: Record<string, unknown> }>(
      sql`select r.id, r.state, r.trigger_payload from runs r join workflow_versions v on v.id = r.workflow_version_id where v.workflow_id = ${workflowId} order by r.created_at`,
    )).rows;

  it("uses ETag 304, extracts CSS selector text, detects changes, and watches RSS feeds", async () => {
    robotsTxt = "";
    const enqueued: string[] = [];
    const wfId = await addMonitorWorkflow({ mode: "page", url: `http://supplier.test:${port}/rice`, selector: ".price", maxChars: 4000 });
    const feedWfId = await addMonitorWorkflow({ mode: "feed", url: `http://supplier.test:${port}/feed.xml`, maxChars: 4000 });

    // Baseline both.
    await pollWebMonitors({ db, guard: localGuard(), enqueue: async (id) => void enqueued.push(id) });
    expect(await runsOf(wfId)).toEqual([]);
    expect(await runsOf(feedWfId)).toEqual([]);

    // 304 Not Modified on unchanged ETag.
    await due(wfId);
    const beforeHits = pageRequests;
    await pollWebMonitors({ db, guard: localGuard(), enqueue: async (id) => void enqueued.push(id) });
    expect(pageRequests).toBe(beforeHits + 1);
    expect(await runsOf(wfId)).toEqual([]);

    // Price changes + new RSS entry.
    price = "PHP 58.00";
    etag = '"v2"';
    feedItems = [{ id: "g2", title: "Flash sale" }, ...feedItems];
    await due(wfId);
    await due(feedWfId);
    await pollWebMonitors({ db, guard: localGuard(), enqueue: async (id) => void enqueued.push(id) });

    const pageRuns = await runsOf(wfId);
    expect(pageRuns).toHaveLength(1);
    expect(pageRuns[0]!.trigger_payload).toMatchObject({ value: "PHP 58.00", previous: "PHP 52.00" });

    const feedRuns = await runsOf(feedWfId);
    expect(feedRuns).toHaveLength(1);
    expect(feedRuns[0]!.trigger_payload).toMatchObject({ itemId: "g2", title: "Flash sale", feedTitle: "Shop" });
  });

  it("blocks private loopback addresses under the default SSRF guard and obeys robots.txt disallow", async () => {
    const ssrfWfId = await addMonitorWorkflow({ mode: "page", url: `http://127.0.0.1:${port}/rice`, maxChars: 4000 });
    await pollWebMonitors({ db, enqueue: async () => {} });
    const [ssrfRow] = await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, ssrfWfId));
    expect(ssrfRow!.problem).toBeTruthy();
    expect(await runsOf(ssrfWfId)).toEqual([]);

    robotsTxt = "User-agent: *\nDisallow: /\n";
    const robotsWfId = await addMonitorWorkflow({ mode: "page", url: `http://supplier.test:${port}/rice`, maxChars: 4000 });
    await pollWebMonitors({ db, guard: localGuard(), enqueue: async () => {} });
    const [robRow] = await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, robotsWfId));
    expect(robRow!.problem).toMatch(/bots not to read this page/i);
    robotsTxt = "";
  });

  it("wires the worker timer to poll web monitors and execute triggered runs", async () => {
    price = "PHP 60.00";
    etag = '"w1"';
    const wfId = await addMonitorWorkflow({ mode: "page", url: `http://supplier.test:${port}/rice`, selector: ".price", maxChars: 4000 });
    let worker: Worker | undefined;
    try {
      worker = await startWorker({
        connectionString: dbUrl,
        db,
        executor: { execute: async () => ({ output: { ok: true } }) },
        leaseMs: 2000,
        sweepMs: 250,
        pollingIntervalSeconds: 0.5,
        monitorTriggers: { tickMs: 200, intervalMs: 200, guard: localGuard() },
      });

      // Wait for baseline cursor to appear.
      for (let i = 0; i < 40; i++) {
        const [p] = await db.select().from(triggerPolls).where(eq(triggerPolls.workflowId, wfId));
        if (p?.cursor) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      price = "PHP 65.00";
      etag = '"w2"';

      let finished = false;
      for (let i = 0; i < 60; i++) {
        const list = await runsOf(wfId);
        if (list.some((r) => r.state === "succeeded")) {
          finished = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(finished).toBe(true);
    } finally {
      await worker?.stop();
    }
  }, 30_000);
});
