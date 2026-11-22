# 0104: Discord and Google Docs steps (phase I1)

## Context

Owners asked for two more steps: post to a Discord channel, and make a Google Docs document from a template with values filled in. A Discord webhook URL was once pasted into a workflow definition as plain text, which is why the link must be a stored, encrypted connection now. Phase I2 (Shopify) runs at the same time and touches the same files, so this work stays in its own blocks.

## Options

- Discord: a bot token and the Discord API, or a channel webhook URL. A bot needs an app, an install and permissions; a webhook is one link per channel, which is what a small office wants.
- Docs: Google's `documents` scope with a new consent, or the `drive.file` grant the Google Drive connection already has. A template could be typed as a link, or picked in the Google Picker.
- Docs delivery shape: a queued delivery like Slack, or a step that runs the copy itself and outputs the link, so later steps can use it.

## Decision

- Discord is a connection (`discord`, migration 0047) following the Teams pattern: the webhook URL is stored encrypted, write-only through the API, never in definitions, run history, deliveries, logs or AI prompts. The step queues a delivery with the connection pinned at queue time, and the delivery worker posts it. An unknown outcome (a 5xx or a lost connection after the request left) is `needs_review`, with Retry and Post again.
- The URL must be https on `discord.com` or `discordapp.com` (subdomains allowed), no user info, no query, and the exact `/api/webhooks/<id>/<token>` path, so the URL cannot point at an internal host. Redirects are refused. The operator may list more hosts in `DISCORD_WEBHOOK_HOSTS` (empty by default; http allowed on those only), which tests use for the fake.
- Messages are sent with `?wait=true` (success is known, not guessed) and `allowed_mentions.parse = []`, so text from a public form cannot ping `@everyone` or a role. 429 waits for Discord's `Retry-After`, or `retry_after` from the body, capped at the provider limit. 404, 401 and 403 mark the connection as needing a new link. The text is limited to 2000 characters, checked after values are filled in.
- Make a document uses the Google Drive connection and its `drive.file` grant: no new scope and no new consent screen. Google lists `drive.file` for both `files.copy` and `documents.batchUpdate` (checked on 22 November 2026 against developers.google.com). The template is chosen with the Google Picker (a Google Docs view), the server reads it with Daloy's grant before the id is kept in the step, and the copy goes into the Drive folder already picked in Apps. A forged template id gets a 404 from Google. It needs a Google sign-in, since a service account has no Drive storage.
- Placeholders are `{{name}}`, replaced with `replaceAllText` in one `batchUpdate`. Each `{{name}}` first becomes a random token and only then becomes its value, so a value that contains `{{other}}` is inserted as plain text and never replaced again, whatever the order of keys. A batch is all or nothing.
- The Docs step runs inside the step, not as a queued delivery, because later steps need the link (`steps.<id>.output.url`, `documentId`, `name`). Retrying is safe without a review state: every copy carries a hash of the run and step in `appProperties`, and a retry looks for its own copy first and only finishes filling it. A lost answer on the copy is therefore "try again", not "unknown".

## Consequences

- Drive's file list can lag a few seconds behind a write, so a retry inside that window can leave a second copy. Rare, and the extra copy is in the owner's own folder.
- Placeholders that match nothing in a fresh copy are reported in the step output (`unmatched`), not as an error.
- Discord messages land in a channel everyone in it can read. The Apps card says so, and the step text should not carry names or emails.
- The Google Docs API must be turned on in the installation's Google Cloud project. The step says so when Google answers that it is off.
- Migration 0047 and this number may need renumbering when phase I2 merges.
