# App logos

These files are shown by `src/AppMark.tsx` on the Apps page, on automation nodes and in the step lists. Each logo is shown as published: no recolouring, no cropping, no rotation, no effects, and with empty space around it (the picture fills about 60% of its tile, so the clear space is at least a fifth of the logo's width on every side). The tile is always white so a dark logo stays readable in the dark theme. Every mark has a text name for screen readers and falls back to a letter tile if the image does not load. Decision record: `docs/decisions/0085-app-logos.md`.

Collected on 2026-11-21. Trademarks belong to their owners. Daloy is not affiliated with or endorsed by any of them, and the logos only identify the app a step connects to.

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

Why Simple Icons for two: the Commons copy of the Airtable logo could not be downloaded (HTTP 429 from Wikimedia during the session) and the Commons Trello file is the full wordmark with a gradient, not the icon. Simple Icons draws the icon as one colour, so these two are single-colour versions.

Discord and Google Docs were added on 2026-11-22 (phase I1) from the same Simple Icons package version, for the same reason: one source with a CC0 licence that could be fetched in the session. No Wikimedia Commons copy was looked for. Both are single-colour marks. If the owner prefers the multi-colour Google Docs icon to match the other Google marks, replace `google-docs.svg` with a copy of it from Commons; the name stays the same.

## Brands that stay a letter tile

| Brand | Why |
|---|---|
| GCash | Not in Simple Icons. Mynt publishes no public brand kit that could be fetched here, and no Commons copy was checked. |
| PayMongo | Not in Simple Icons and no public brand kit was found (https://www.paymongo.com/brand returns 404). |
| UniSMS | Not in Simple Icons and no logo was found. |
| Facebook Messenger, Instagram | Meta's guidelines say to use only the logos from its Brand Resource Center after accepting its terms (https://about.instagram.com/brand/). That download needs the owner's acceptance, and a copy from Commons or Simple Icons is not that file, so no copy is used. To switch: download the pack as the owner, add `messenger.svg` and `instagram.svg` here, add the names to `LOGOS` in `AppMark.tsx` and remove them from `LETTER_TILES`. |

## What was not checked

The brand guideline pages for Google, Microsoft, Slack, Telegram, Notion, Airtable and Atlassian either load their text with scripts or could not be fetched in the session (Microsoft returned 403). The rules applied to every logo are the ones all of these brands share: show the mark unaltered, keep clear space, do not imply endorsement. The owner should read each brand's current guidelines before launch, and replace a file with the brand's own kit file where the guidelines require it. A swap is one file in this folder, with the same name.
