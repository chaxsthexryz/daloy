# App logos

These files are shown by `src/AppMark.tsx` on the Apps page, on automation nodes and in the step lists. Each logo is shown as published: no recolouring, no cropping, no rotation, no effects, and with empty space around it (the picture fills about 60% of its tile, so the clear space is at least a fifth of the logo's width on every side). The tile is always white so a dark logo stays readable in the dark theme. Every mark has a text name for screen readers and falls back to a letter tile if the image does not load. Decision record: `docs/decisions/0085-app-logos.md`.

Collected on 2026-11-21. Trademarks belong to their owners. kymavo is not affiliated with or endorsed by any of them, and the logos only identify the app a step connects to.

## Files

Public-domain files are copies hosted on Wikimedia Commons. Commons marks each one as a simple-geometry logo that carries no copyright, and keeps the trademark note. They are not downloads from the brands' own brand kits. Two further files come from Simple Icons, whose icon data is CC0 (npm package `simple-icons` 16.38.0, https://github.com/simple-icons/simple-icons).

| File | Source | License or terms | Change made |
|---|---|---|---|
| gmail.svg | https://commons.wikimedia.org/wiki/File:Gmail_icon_(2020).svg | Commons: public domain (simple logo), trademark of Google | none |
| google-sheets.svg | https://commons.wikimedia.org/wiki/File:Google_Sheets_logo_(2014-2020).svg | Commons: public domain (simple logo), trademark of Google | none |
| google-drive.svg | https://commons.wikimedia.org/wiki/File:Google_Drive_icon_(2020).svg | Commons: public domain (simple logo), trademark of Google | none |
| google-calendar.svg | https://commons.wikimedia.org/wiki/File:Google_Calendar_icon_(2020).svg | Commons: public domain (simple logo), trademark of Google | none |
| outlook.svg | https://commons.wikimedia.org/wiki/File:Microsoft_Office_Outlook_(2018%E2%80%932024).svg | Commons: public domain (simple logo), trademark of Microsoft | none |
| teams.svg | https://commons.wikimedia.org/wiki/File:Microsoft_Office_Teams_(2019%E2%80%932025).svg | Commons: public domain (simple logo), trademark of Microsoft | none |
| slack.svg | https://commons.wikimedia.org/wiki/File:Slack_icon_2019.svg | Commons: public domain (simple logo), trademark of Slack Technologies | added a `viewBox` so it scales, nothing else |
| telegram.svg | https://commons.wikimedia.org/wiki/File:Telegram_2019_Logo.svg | Commons: public domain (simple logo), trademark of Telegram | none |
| notion.svg | https://commons.wikimedia.org/wiki/File:Notion-logo.svg | Commons: public domain (simple logo), trademark of Notion Labs | none |
| airtable.svg | https://cdn.jsdelivr.net/npm/simple-icons@16.38.0/icons/airtable.svg | Simple Icons, CC0 (trademark of Airtable) | fill set to Airtable's colour #18BFFF from the Simple Icons data |
| discord.svg | https://cdn.jsdelivr.net/npm/simple-icons@16.38.0/icons/discord.svg | Simple Icons, CC0 (trademark of Discord Inc.) | fill set to Discord's colour #5865F2 from the Simple Icons data |
| google-docs.svg | https://cdn.jsdelivr.net/npm/simple-icons@16.38.0/icons/googledocs.svg | Simple Icons, CC0 (trademark of Google) | fill set to Google Docs' colour #4285F4 from the Simple Icons data |
| trello.svg | https://cdn.jsdelivr.net/npm/simple-icons@16.38.0/icons/trello.svg | Simple Icons, CC0 (trademark of Atlassian) | fill set to Trello's colour #0052CC from the Simple Icons data |
| shopify.svg | https://cdn.jsdelivr.net/npm/simple-icons@16.38.0/icons/shopify.svg | Simple Icons, CC0 (trademark of Shopify). Added on 22 November 2026 | fill set to Shopify's colour #7AB55C from the Simple Icons data. Shopify's brand assets page is https://www.shopify.com/brand-assets; the owner should read its current rules before a public launch |
| lalamove.svg | https://cdn.worldvectorlogo.com/logos/lalamove.svg | Vector mark of Lalamove. Added on 25 November 2026 | icon subpath isolated on square viewBox, `#ff671d` preserved |
| messenger.svg | https://cdn.jsdelivr.net/npm/simple-icons@16.38.0/icons/meta.svg | Simple Icons, CC0 (trademark of Meta Platforms). Added on 25 November 2026 | blue gradient `#0064E0` -> `#0082FB` applied to Meta infinity mark |
| whatsapp.svg | https://cdn.jsdelivr.net/npm/simple-icons@16.38.0/icons/whatsapp.svg | Simple Icons, CC0 (trademark of Meta / WhatsApp). Added on 25 November 2026 | WhatsApp green `#25D366` fill applied |
| paymongo.svg | Owner-provided brand mark uploaded on 25 November 2026 | Trademark of PayMongo | traced cleanly to vector SVG with `#223f37` fill on square viewBox |

Why Simple Icons for two (Airtable and Trello; Shopify was added the same way because Commons has no copy that was checked): the Commons copy of the Airtable logo could not be downloaded (HTTP 429 from Wikimedia during the session) and the Commons Trello file is the full wordmark with a gradient, not the icon. Simple Icons draws the icon as one colour, so these two are single-colour versions.

Discord and Google Docs were added on 2026-11-22 (phase I1) from the same Simple Icons package version, for the same reason: one source with a CC0 licence that could be fetched in the session. No Wikimedia Commons copy was looked for. Both are single-colour marks. If the owner prefers the multi-colour Google Docs icon to match the other Google marks, replace `google-docs.svg` with a copy of it from Commons; the name stays the same.

## Brands that stay a letter tile

| Brand | Why |
|---|---|
| GCash | Not in Simple Icons. Mynt publishes no public brand kit that could be fetched here, and no Commons copy was checked. |
| UniSMS | Not in Simple Icons and no logo was found. |
| Instagram | Instagram icon mark not yet supplied in the workspace bundle; stays a letter tile until provided. |

## What was not checked

The brand guideline pages for Google, Microsoft, Slack, Telegram, Notion, Airtable and Atlassian either load their text with scripts or could not be fetched in the session (Microsoft returned 403). The rules applied to every logo are the ones all of these brands share: show the mark unaltered, keep clear space, do not imply endorsement. The owner should read each brand's current guidelines before launch, and replace a file with the brand's own kit file where the guidelines require it. A swap is one file in this folder, with the same name.
