# 0042: Telegram messages as a delivery, Viber left out

## Context

N14 asks for bot messages to Telegram and Viber, sent like Slack: queued, retried, pinned, held for review when the outcome is unknown. Daloy is free and open source only.

## Options

- Viber and Telegram, or Telegram only.
- Pick the chat from a list, or take a chat id.
- Send plain text or Markdown.

## Decision

- Telegram only. Viber's bot API needs a commercial agreement: bots created since 5 February 2024 pay about EUR 100 a month, and tokens come after approval ([Viber FAQ](https://help.viber.com/hc/en-us/articles/8790322961309), checked 2026-11-17). That is not free to use, so it is not built. Revisit if Viber drops the fee.
- Telegram is a fifth provider next to Sheets, Slack, Outlook and Teams. Migration 0023 only widens the `connections_provider` and `deliveries_provider` checks. No new table.
- `PUT /settings/connections/telegram { token, chatId }` checks the token shape (`<id>:<secret>`) and the chat id (a number, or a public `@name`), then calls `getMe` and `getChat`. It saves the bot name as the account and `{ chatId, chatTitle }` as the destination in one step. The token is encrypted like Slack's and never returned. `POST .../telegram/test` sends a test message.
- The `telegram` step is `{ text }`, same as Slack. The step queues a delivery and the worker sends `sendMessage`. The connection and chat are pinned when it is queued: a changed bot or chat holds the delivery for review and sends nothing (like Slack, decision 0021).
- Errors: 401 means reconnect (the connection is marked failed), 403 or "chat not found" means permission (fails with a hint), 429 queues again after `retry_after`, 5xx or a timeout on send is ambiguous, so it goes to needs_review (Retry stays off, Post again is the choice). Messages are plain text with no `parse_mode`.
- The base URL is `TELEGRAM_API_URL` (env only, default `https://api.telegram.org`), so the fake server can stand in during tests. A user cannot set it.

## Consequences

- The bot token is in every request URL, as Telegram requires. Daloy never logs or returns the request URL, and error messages never include it.
- The owner finds the chat id themselves (add the bot, send a message, read it from the bot's updates). A chat picker would need `getUpdates`, which is not worth it for N14.
- A Telegram bot cannot read back what it sent, so an unknown outcome is always a person's call.
