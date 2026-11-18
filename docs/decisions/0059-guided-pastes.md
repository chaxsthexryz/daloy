# 0059: Guided paste setups

## Context

Telegram, Teams and PayMongo have no OAuth, so the owner still pastes a value (managed OAuth plan, phase P7). The old cards were one form each. The plan asks for numbered steps with a live result, a Telegram chat picker, and a Teams test after saving.

## Decision

- One small `GuidedSteps` component (numbered list, one action per step, a check line) is used by all three cards. The three setups live in `PasteSetups.tsx`, and `Connections.tsx` only mounts them, so the shared card code changes little.
- Telegram chat discovery is one owner-only route, `POST /settings/connections/telegram/chats`, taking the token in the body. It cannot be a GET on the saved connection, because the token is pasted before anything is saved, and a token must not sit in a URL. It returns the bot name, the chats (id, type, title) and a `webhookSet` flag. A webhook-set bot is a normal 200 with the flag, not an error, so the token check still succeeds and the page can explain in plain words. Message text is never copied out of the Bot API answer.
- `getUpdates` discovery is unverified against the live Bot API. The route and the fake follow the documented behaviour (no webhook allowed, 409 otherwise, updates kept for about a day). Re-check it on the first live run.
- Teams: the console sends the test message right after saving, using the existing test route. The server stays unchanged. The copy says menu names may differ and links to the Microsoft help page, because the Teams menus could not be checked.
- PayMongo: the webhook address only exists once the key is saved, but the old form demanded the `whsk_` secret in the same request, so a first-time owner had no address to give PayMongo. `PUT .../paymongo` now accepts the key alone and marks the connection `webhookPending` until the secret arrives. The public hook refuses every event while the secret is empty, so an empty HMAC key can never verify a signature. Replacing only the key keeps the saved secret.
- Creating the PayMongo webhook through their API is not built. Whether that call exists for a secret key, and where it returns the signing secret, is unverified (plan section 15). Possible follow-up once checked against the live API.

## Consequences

- The Telegram route is a new read of recent chat titles for the owner. See docs/threat-model.md.
- The PayMongo first save can now leave a connection that records nothing until the secret is added. The card says so.
