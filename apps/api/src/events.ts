import { EVENTS_CHANNEL, EVENT_KINDS, notificationPrefs, type Db, type EventKind } from "@daloy/db";
import { Body, Controller, Get, HttpException, HttpStatus, Inject, Injectable, Put, Req, Res, UseGuards, type OnModuleDestroy } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import * as z from "zod";
import { SessionGuard, sessionUser } from "./auth";
import { Allow, CONFIG, CurrentUser, DB, OPERATE, ZodPipe, type ApiConfig, type SessionUser } from "./http";

/** What a member chose to see in the bell (decision 0155). No row means these defaults; successful runs start off. */
export type NotificationPrefs = { chats: boolean; handoff: boolean; runsSucceeded: boolean; runsFailed: boolean };
export const DEFAULT_PREFS: NotificationPrefs = { chats: true, handoff: true, runsSucceeded: false, runsFailed: true };
const PREF_OF_KIND: Record<EventKind, keyof NotificationPrefs> = { conversation_new: "chats", handoff_requested: "handoff", run_succeeded: "runsSucceeded", run_failed: "runsFailed" };

const prefsInput = z.strictObject({ chats: z.boolean(), handoff: z.boolean(), runsSucceeded: z.boolean(), runsFailed: z.boolean() });
const eventShape = z.object({ workspaceId: z.string().max(64), kind: z.enum(EVENT_KINDS), id: z.string().max(64), title: z.string().max(200), at: z.string().max(40) });

async function readPrefs(db: Db, userId: string): Promise<NotificationPrefs> {
  const [row] = await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId));
  return row ? { chats: row.chats, handoff: row.handoff, runsSucceeded: row.runsSucceeded, runsFailed: row.runsFailed } : { ...DEFAULT_PREFS };
}

type Subscriber = { userId: string; workspaceId: string; prefs: NotificationPrefs; send: (e: { kind: EventKind; id: string; title: string; at: string }) => void };

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * One LISTEN connection for the whole API process, shared by every open console stream (decision 0155). It connects when
 * the first stream opens and reconnects with a growing delay if the connection drops. Events sent while it was down are
 * not replayed: the bell is a live view, and the inbox and runs pages hold the record.
 * Limit: preference changes reach streams open in this process at once, and streams in another API process on their next
 * connect. The installation runs one API process.
 */
@Injectable()
export class EventHub implements OnModuleDestroy {
  private readonly subs = new Set<Subscriber>();
  private client: PoolClient | null = null;
  private connecting: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs = RECONNECT_MIN_MS;
  private closed = false;

  constructor(@Inject(DB) private readonly db: Db) {}

  /** Adds a stream and resolves once the LISTEN is in place, so no event between "open" and "listening" is missed. */
  async add(sub: Subscriber): Promise<void> {
    this.subs.add(sub);
    try {
      await this.listen();
    } catch (err) {
      // The stream stays: the reconnect timer retries, and it opens with no events until the connection is back.
      console.error("live events: listen failed", err instanceof Error ? err.name : "error");
    }
  }

  remove(sub: Subscriber) {
    this.subs.delete(sub);
  }

  /** A saved change applies to this person's open streams straight away. */
  setPrefs(userId: string, prefs: NotificationPrefs) {
    for (const s of this.subs) if (s.userId === userId) s.prefs = prefs;
  }

  private listen(): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    this.connecting ??= (async () => {
      const client = await this.db.$client.connect();
      client.on("notification", (n) => this.dispatch(n.payload ?? ""));
      const lost = () => {
        if (this.client !== client) return;
        this.client = null;
        client.removeAllListeners();
        client.release(true);
        if (!this.closed && this.subs.size > 0) this.scheduleReconnect();
      };
      client.on("error", lost);
      client.on("end", lost);
      try {
        await client.query(`LISTEN ${EVENTS_CHANNEL}`);
      } catch (err) {
        client.removeAllListeners();
        client.release(true);
        throw err;
      }
      this.client = client;
      this.retryMs = RECONNECT_MIN_MS;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private scheduleReconnect() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.listen().catch(() => {
        this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
        if (!this.closed && this.subs.size > 0) this.scheduleReconnect();
      });
    }, this.retryMs);
    this.retryTimer.unref();
  }

  /** Parses one notification and sends it to the streams of that workspace whose owner wants this kind. Anything else is dropped. */
  private dispatch(raw: string) {
    let parsed: z.output<typeof eventShape>;
    try {
      parsed = eventShape.parse(JSON.parse(raw));
    } catch {
      return;
    }
    const { workspaceId, ...out } = parsed;
    for (const s of this.subs) {
      if (s.workspaceId !== workspaceId || !s.prefs[PREF_OF_KIND[out.kind]]) continue;
      try {
        s.send(out);
      } catch {
        // A stream that cannot be written to is cleaned up by its own close handler.
      }
    }
  }

  onModuleDestroy() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.client?.removeAllListeners();
    this.client?.release(true);
    this.client = null;
    this.subs.clear();
  }
}

/**
 * GET /events: a Server-Sent Events stream of the live events for the signed-in owner's or operator's own workspace
 * (decision 0155). Approvers and requesters get no live feed. The response carries Cache-Control no-transform and
 * X-Accel-Buffering no so no proxy rewrites or holds it (the API itself has no compression middleware), and a comment
 * line every 25 seconds so Cloudflare's 100 second idle timeout never closes it. Each beat also checks the session, so a
 * stream ends after sign-out or when the person's role no longer allows it.
 */
@Controller("events")
@UseGuards(SessionGuard, Allow(OPERATE))
export class EventsController {
  private readonly open = new Map<string, number>();
  private seq = 0;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(EventHub) private readonly hub: EventHub,
  ) {}

  @Get()
  async stream(@CurrentUser() user: SessionUser, @Req() req: Request, @Res() res: Response) {
    const max = this.config.eventsMaxStreams ?? 5;
    // Counted before any await, so streams opened at the same moment cannot all slip under the cap.
    const count = this.open.get(user.id) ?? 0;
    if (count >= max) throw new HttpException("too many open event streams for this account", HttpStatus.TOO_MANY_REQUESTS);
    this.open.set(user.id, count + 1);

    let done = false;
    const timer: { beat?: NodeJS.Timeout } = {};
    const sub: Subscriber = {
      userId: user.id,
      workspaceId: user.workspaceId,
      prefs: { ...DEFAULT_PREFS },
      send: (e) => { if (!done) res.write(`id: ${++this.seq}\ndata: ${JSON.stringify(e)}\n\n`); },
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer.beat);
      this.hub.remove(sub);
      const left = (this.open.get(user.id) ?? 1) - 1;
      if (left > 0) this.open.set(user.id, left); else this.open.delete(user.id);
      res.end();
    };
    res.on("close", finish);

    try {
      sub.prefs = await readPrefs(this.db, user.id);
      await this.hub.add(sub);
    } catch (err) {
      finish();
      throw err;
    }
    if (done) return;

    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    // The browser waits 5 seconds before it reconnects on its own.
    res.write("retry: 5000\n\n");

    timer.beat = setInterval(() => {
      sessionUser(this.db, req).then((now) => {
        if (!now || !OPERATE.includes(now.role)) finish();
      }, () => undefined);
      if (!done) res.write(": heartbeat\n\n");
    }, this.config.eventsHeartbeatMs ?? 25_000);
  }
}

@Controller("settings/notifications")
@UseGuards(SessionGuard, Allow(OPERATE))
export class NotificationPrefsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EventHub) private readonly hub: EventHub,
  ) {}

  @Get()
  get(@CurrentUser() user: SessionUser) {
    return readPrefs(this.db, user.id);
  }

  @Put()
  async put(@CurrentUser() user: SessionUser, @Body(new ZodPipe(prefsInput)) body: z.output<typeof prefsInput>) {
    await this.db
      .insert(notificationPrefs)
      .values({ userId: user.id, ...body })
      .onConflictDoUpdate({ target: notificationPrefs.userId, set: { ...body, updatedAt: new Date() } });
    this.hub.setPrefs(user.id, body);
    return body;
  }
}
