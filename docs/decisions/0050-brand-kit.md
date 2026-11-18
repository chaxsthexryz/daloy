# 0050: Brand kit

## Context

The owner wants their business name, logo and one colour on public forms, booking pages and outgoing emails. The business name already lives in `business_profiles`. A logo upload is a file from a signed-in user that other people's browsers and mail clients then load, so type and size matter, and nothing may be fetched from another site.

## Options

1. Store a logo URL and let pages and emails link to it. Fetches from another site, leaks who opened the email, and breaks when the site changes.
2. Store the file on local disk. The API and worker may run in different containers, and the codebase keeps all workspace data in Postgres.
3. Store the bytes in Postgres next to the business name, and serve them from the API.

## Decision

Option 3. Migration 0029 adds `logo` (bytea), `logo_type` and `accent` to `business_profiles`, with check constraints (type is png, jpeg or webp; accent is `#rrggbb`; logo and type are set together).

- Upload: `PUT /settings/brand/logo` takes base64 in JSON (no multipart dependency). At most 100 KB decoded. The type comes from the file's first bytes (`logoType` in `packages/engine/src/brand.ts`), never from the name or the declared type. SVG is refused because it can carry script. Owner role only.
- Serving: `GET /brand/logo/:workspaceId` is public, returns the stored bytes with a fixed image type (`nosniff` comes from helmet) and a 5 minute cache. 404 when there is no logo.
- Colour: `PUT /settings/brand` takes a lowercase `#rrggbb` or null. The text colour on it is computed (`inkFor`, WCAG contrast, white or near black) and never stored. The accent is used only as a fill or border with that text colour on top.
- Public pages: `page()` takes an optional brand. With a logo or accent it adds a small style block and the logo from the same origin. Without either, the HTML is the same as before. Approval pages are unchanged.
- Emails: `sendAs` reads the brand before it takes the send lock (a query under the lock is what decision 0030 forbids). With a logo or accent, the message gets an HTML part (accent band, name, logo attached inline by cid) and the text part ends with the business name. Without them, the message is the same plain text as before.
- The brand counts as set when a logo or an accent exists. A name alone changes nothing new, so existing workspaces look the same.

## Consequences

- The logo is checked by its bytes but not decoded, so a corrupt image that starts with a valid signature is stored and shows as a broken image.
- The logo URL contains the workspace id, which is a random UUID and already appears in no other public page.
- Email clients that block images show the name and colour band without the logo.
