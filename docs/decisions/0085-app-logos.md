# 0085. Real app logos instead of letter tiles, with letter tiles kept where no usable asset exists

## Context

`Apps.tsx` showed a letter in a tile for every app because the brands' logos are trademarks. The owner now wants the real logos for every app Daloy connects to, including Google's. A logo here only identifies the app a step talks to. The brands' guidelines ask for the unaltered mark, clear space and no implied endorsement.

## Options

1. Keep letter tiles. No trademark question, but a seller cannot tell Gmail from Outlook at a glance.
2. Use each brand's own brand kit. Best on terms, but several kits sit behind a terms click or a script-rendered page, and a coding agent should not accept terms for the owner.
3. Use copies of the published logos from Wikimedia Commons (public domain as simple geometry, trademark noted), and Simple Icons (CC0 data, one colour) where the Commons copy is missing or is a wordmark.
4. Draw our own look-alike marks. Rejected: a redrawn logo is an altered logo.

## Decision

Option 3 for Gmail, Google Sheets, Drive, Calendar, Outlook, Teams, Slack, Telegram, Notion (Commons) and Airtable, Trello (Simple Icons, in the brand colour). Facebook Messenger and Instagram stay letter tiles: Meta's guidelines say to use only the logos from its Brand Resource Center, and that download needs the owner to accept Meta's terms. GCash, PayMongo and UniSMS stay letter tiles because no usable asset exists. `apps/web/public/logos/README.md` records the source URL, terms, date and any change for each file, and the reason for each tile.

A logo is drawn by `AppMark`: unaltered, on a white tile, with padding of at least a fifth of its width, a text name for screen readers, and a letter tile if the image fails to load. Where the catalog names an action Daloy does itself (a branch, a wait, an approval) the mark is a Daloy line icon.

## Consequences

- The owner must read each brand's current guidelines before launch. The README says which pages could not be read here. Replacing a logo with a kit file is one file with the same name.
- Switching Messenger and Instagram to logos needs the owner to download Meta's pack and add two files.
- Airtable and Trello are single-colour versions of their logos.
- `AppMark.test.ts` fails if a logo file is missing, has no README entry or contains script, or if a catalog mark has no picture, icon or tile.
