# 0117: Telegram message trigger

## Context

T9 asks for a trigger that starts a workflow when the owner sends a photo or PDF to their own Telegram bot, made with @BotFather. The first use is a seller forwarding GCash receipt screenshots, so the AI step can read them and a Sheets row can be added. Sending to Telegram already works (decision 0042). The Bot API facts below are from core.telegram.org/bots/api as known on 23 November 2026, and nothing here has run against the live Bot API yet.

- `setWebhook(url, secret_token, allowed_updates, max_connections)` makes Telegram POST each update to `url` over https only. `secret_token` (1 to 256 characters of `A-Z a-z 0-9 _ -`) comes back in the `X-Telegram-Bot-Api-Secret-Token` header. Telegram signs nothing else.
- While a webhook is set, `getUpdates` answers 409, so the connect wizard cannot list the bot's chats.
- Telegram retries an update that is not answered with 2xx, and the same update keeps its `update_id`.
- A photo arrives as a list of sizes, small to large, all JPEG. A file sent "as a file" arrives as a `document` with the sender's `mime_type` and file name. `getFile` gives a `file_path` on `https://api.telegram.org/file/bot<token>/`, and bots may download up to 20 MB.

## Options

1. Poll `getUpdates` from the worker. No public address is needed, but it means a long-running poller per bot and an offset to keep, and Telegram allows only one consumer per bot.
2. A webhook set when the owner connects, for every Telegram connection. Simple, but it changes the bot of every owner who only sends messages, and their wizard stops listing chats.
3. A webhook set only when the owner turns on Receive messages on the Telegram card. Chosen.
4. Store a random `secret_token` next to the token. It would need a new column or a JSON credential, which changes every reader of the Telegram credential.

## Decision

- `PUT /settings/connections/telegram` takes `receive: true`. Daloy keeps or makes a 32-byte random path, calls `setWebhook` with `<PUBLIC_URL>/hooks/telegram/<path>`, `allowed_updates: ["message"]` and a secret token, and saves `webhookPath` and `webhook: registered | failed` in the destination. A refused address (local installs have no public https address) still saves the connection with `failed`, as Shopify does (decision 0105). `receive: false` and Disconnect call `deleteWebhook`, best effort.
- The secret token is `base64url(HMAC-SHA256(bot token, "daloy telegram webhook " + path))`. The bot token is already stored encrypted, so nothing new is stored, and a new token or path gives a new secret. No migration.
- `POST /hooks/telegram/:path` (`TelegramHooksController`, 120 calls a minute): an unknown path is 403, a missing or wrong secret header is 401 (constant-time compare), and only then is the body parsed. Anything other than a new `message` is 200 with no run.
- Trigger `telegram_message` with `from: my_chat | anyone` (default `my_chat`, the chat chosen in Apps) and `requireFile` (default true). Each run is keyed `telegram:<bot id>:<update_id>` per workflow, so a retry or a concurrent duplicate starts one run.
- Files: a photo (the largest size that fits) or a document whose `mime_type` is JPEG, PNG, WebP or PDF. The declared size, the `getFile` size, the `Content-Length` and the bytes read are each held to 5 MB (`FILE_MAX_BYTES`), and the bytes must sniff as one of those four types. The file is stored as the upload field `file`, which an AI step can read and a Drive step can save. A file server that is down answers 503 so Telegram sends the update again. A refused file leaves `fileRefused: true` in the trigger data.
- Reply: the `telegram` step gets an optional `chatId`. It is allowed only under a `telegram_message` trigger, and the rendered value must equal the run's `trigger.chatId`, so run data cannot point the bot at another chat. The delivery carries the chat; without it the chat chosen in Apps is used, as before.
- Template `telegram-gcash-receipts`, "Log GCash receipts from Telegram": AI extract of reference, amount, sender and date, a Sheets row starting with "To check", and a reply to the sender. The AI step's duplicate reference check (N16) also runs.

## Consequences

- An owner with Receive messages on cannot use the wizard's chat list; they type the chat id or turn receiving off first. The card says so.
- Telegram's servers share a few addresses, and the rate limit is per address, so many busy bots on one installation share 120 calls a minute. Telegram retries a 429.
- In "anyone" mode strangers can start runs and spend AI and upload usage. The default is "my chat only".
- A file over 5 MB or of another type starts no run when a file is required, and the sender gets no answer.
- Replacing the token with another bot's token leaves the old bot's webhook pointing at a path that now answers 401.
