# 0119: Guarded answers, stay quote and payment amount trust

## Context

C4 of the resort concierge plan (`docs/plans/resort-concierge.md`). A resort concierge answers guest messages from the published knowledge sheet (C3) and conversation history (C1), and calculates deposit quotes for stays. Without deterministic checks, a language model can invent a discount, claim a room is free or available (the resort also sells rooms on other channels), echo phishing links, or see guest contact details it does not need. Separately, review item L7 noted that `payment_due` checked `{{trigger.*}}` directly from untrusted triggers, leaving a gap if an AI step or another step copied guest text or model output into an amount.

## Options

1. Ask the model in the prompt not to invent prices or mention availability, and let it compute stay totals. Rejected: prompt rules alone are advisory and fail under adversarial guest text or model slips, and arithmetic across season boundaries and weekday rules is error-prone in a model.
2. Separate plain-code guards and pricing from the model: mask contacts before the prompt, run a deterministic `guardReply` check over the model reply, move stay pricing into a pure `stay_quote` step, and walk `payment_due` amount templates transitively across step references. Chosen.

## Decision

- AI `answer` task (`packages/engine/src/ai.ts`, `packages/engine/src/concierge.ts`, `apps/worker/src/steps/ai.ts`): reads the workspace's highest published `knowledge_versions` row (`readKnowledge`) and the conversation's recent history. Before calling the model, `redactContacts` replaces emails with `[email]` and 10 to 13 digit phone numbers starting with `+`, `0` or `63` with `[phone]`. Guest text stays in the delimited `<data>` user message while the published knowledge JSON sits in the system prompt. Output is validated against `{ reply, entryIds, intent, needsHuman, fields }`, filtering `entryIds` to real ids in that version. Contacts in the guest's message (`contactsIn`) are extracted by fixed pattern and merged over `fields`.
- Deterministic reply guard (`guardReply` in `packages/engine/src/concierge.ts`):
  1. Strips `[email]`, `[phone]` and any `{{...}}` template braces (`flags: ["placeholder"]`).
  2. Strips any URL or bare domain not found in the published knowledge entries' links or bodies or the passed pay link (`flags: ["link"]`).
  3. Replaces the entire reply with a fixed team-handoff message (`needsHuman: true`) if it matches availability phrases in English or Tagalog (`available`, `vacant`, `fully booked`, `bakante`, `may slot`, `puno na`, and related forms).
  4. Replaces the entire reply with a fixed rate-confirmation message (`needsHuman: true`) if any peso figure or rate-phrase number (such as `₱2,999`, `PHP 4200`, `500 pesos`, or `2800 per night`) does not appear in the numeric prices, rules, fixed deposits or body figures of a priced entry (`room`, `rate`, `fee`) that the answer actually cited in `entryIds`.
- `stay_quote` step (`quoteStay` in `packages/engine/src/concierge.ts`, executed in `apps/worker/src/steps/index.ts`): takes `room` (entry id or case-insensitive title), `checkIn` (`YYYY-MM-DD`), `nights` (1 to 30) and `guests` (1 to 500) and prices each night from the published knowledge version. Rule precedence when multiple rules match a date: season plus weekdays beats season alone, which beats weekdays alone, which beats neither; between two matching seasons, the shorter span wins; on a full tie, the earlier rule wins. Supports `night` and `person_night` units, per-person or per-person-night extra-guest rules when over capacity, and fixed or percent deposits. Marked read-only, so test runs also quote against the published knowledge sheet.
- Closing L7 for `payment_due` (`untrustedSource` in `packages/engine/src/definition.ts`): follows every `{{steps.<id>...}}` reference in `payment_due.config.amount` and `total` transitively through upstream step configs. Save refuses the workflow if any upstream step is an `ai` step or reads `{{trigger.*}}` from an untrusted trigger (`meta_dm`, `form`, `email`, `telegram_message`, or an unsigned `webhook`).
- No database migration is needed: C4 reads C3's `knowledge_versions` and C1's `conversations`. Local `Build with AI` model prompts keep `answer` out of `ai.config.task` and leave `stay_quote` in `HOSTED_ONLY` so small local models stay within their context budget.

## Consequences

- Every price and deposit shown to a guest comes from the owner's published knowledge version, and `payment_due` amounts can only come from fixed values, trusted triggers, or `stay_quote` fed by staff or trusted inputs.
- Real-model answer quality in English and Taglish is still unverified against live traffic until C9's 50-conversation measurement; until then, `guardReply` is tuned to fail closed toward staff handoff whenever a reply looks like an availability claim or uncited rate.
- A harmless number right next to a rate word (or a legitimate total the model multiplied itself instead of using `stay_quote`) triggers a rate-confirmation handoff rather than letting an unverified figure reach the guest.
