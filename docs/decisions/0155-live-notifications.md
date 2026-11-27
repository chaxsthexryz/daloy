# 0155. Live notifications in the console

## Status

Accepted

## Context

The owner asked for a notification when someone chats or a live run finishes, in real time. The console already polls `/runs` every 2 seconds for the run toasts, but nothing tells an owner or operator about a new chat or a handoff unless they have the Inbox open. The stack has no Redis and no WebSocket server, and the rule is free and local only.

## Options

1. Poll more endpoints from the browser. Simple, but every open tab costs a query every few seconds and a chat can wait seconds to show.
2. WebSockets. Needs a gateway, sticky sessions and heartbeats of its own, and the console only needs a one-way feed.
3. Server-Sent Events fed by Postgres `LISTEN/NOTIFY`. One-way, works with the existing cookie session, reconnects by itself in the browser, and adds no service.
4. Redis pub/sub. A new service for something Postgres already does.

## Decision

Option 3.

Publishing. `packages/db/src/events.ts` sends `pg_notify('kymavo_events', payload)`. The payload is `{ workspaceId, kind, id, title, at }`. `kind` is `run_succeeded`, `run_failed`, `conversation_new` or `handoff_requested`. `id` is the run or conversation id. `title` is the workflow name for a run and the channel name ("Messenger", "Telegram") for a chat, cut to 80 characters. Message text, customer names, run errors and secrets never go in it, so the payload is a pointer and stays far below NOTIFY's 8,000 bytes. A test sends a message with a card number and checks that nothing from it reaches the channel.

Where it is published:
- `run_succeeded` and `run_failed` in `apps/worker/src/advance.ts`, after the run's state change has committed. Test runs that fake their steps are skipped. A test run marked live counts as a live run.
- `conversation_new` in `recordInbound` (`packages/db/src/conversations.ts`), which every channel uses. It is sent inside the caller's transaction, so Postgres delivers it only if the message is stored, and a replayed message sends nothing.
- `handoff_requested` where the AI step asks for a person (`apps/worker/src/steps/index.ts`), just before the existing staff alert. The alert order (Messenger, Telegram, email) is unchanged.

Publishing never fails a run. `publishEvent` runs in its own nested transaction (a savepoint when the caller has one), catches every error and logs the kind and id, never the payload. A failed notify therefore does not abort the message or run transaction around it.

Delivering. `GET /events` (`apps/api/src/events.ts`) is an SSE stream for owners and operators (`OPERATE`) behind `SessionGuard`. One `EventHub` per API process holds a single dedicated LISTEN connection, opened when the first stream opens, reconnecting with a delay that doubles up to 30 seconds. It checks every notification with zod, drops anything malformed, and sends an event to a stream only if the stream's workspace equals the event's workspace and the person's preference for that kind is on. The workspace id is routing information and is not sent to the browser.

Stream behaviour:
- Headers `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`. The API has no compression middleware (the only "compress" code is the visitor-side photo shrinker), so nothing buffers it in the process. `no-transform` tells Cloudflare and other proxies not to rewrite it.
- `retry: 5000` first, and an `id:` on every event.
- A comment line (`: heartbeat`) every 25 seconds, under Cloudflare's 100 second idle limit. Each beat also re-reads the session, so a stream ends after sign-out or when the role no longer allows it.
- At most 5 open streams per user. The sixth gets 429. The count is taken before any await, so parallel opens cannot slip past it. A closed stream frees its slot on disconnect.

Preferences. Table `notification_prefs` (migration `0064_notification_prefs.sql`), one optional row per user: `chats`, `handoff`, `runs_succeeded`, `runs_failed`. No row means the defaults. `GET` and `PUT /settings/notifications` (owner and operator) read and save them, and a save applies at once to that person's open streams.

Defaults: chats on, handoff on, failed runs on, successful runs off. This settles open question 3 of the admin console plan. A busy workspace finishes many runs an hour, and a bell that rings for each one gets ignored, which hides the failure and handoff events that matter. Each person can turn successful runs on in Settings. The existing run poller still shows a toast for a successful run regardless of this setting; it is the older behaviour and is left as it was.

Web. A bell in the sidebar header (a bell in the bottom bar on a phone) with an unread count, a dropdown of the last 20 events that link to the run log or the conversation (`#/conversations?c=<id>` opens that conversation), and a toast for handoffs and failures. `EventSource` reconnects by itself after a dropped connection. When the server refuses (429, 401), the browser gives up, so the hook reopens after 30 seconds. The stream closes when the console unmounts, so it stops on sign-out. Panel motion runs only when the person has not asked for reduced motion.

## Consequences

- Events sent while the LISTEN connection or the browser connection was down are not replayed. The bell is a live view; the Inbox and the run list hold the record. `Last-Event-ID` is accepted by the browser but ignored.
- Event ids count per API process, so they only order events within a connection.
- Preference saves reach streams in the same API process immediately and streams in another process on their next connect. The installation runs one API process.
- The hub holds one connection from the API's pool permanently once a stream has opened. The pool default is 10.
- A run that finishes while no one is connected rings nothing later. That is intended.
- Approvers and requesters have no live feed. `GET /events` answers them 403.
