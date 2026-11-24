# Resort Concierge 50-Conversation Safety Evaluation (C9)

Recorded in `packages/engine/src/concierge-eval.test.ts` as part of phase C9.

## Scope

50 scripted guest and model interactions covering English, Tagalog, and Taglish inputs across `guardReply`, `answerPrompt`, `redactContacts`, `contactsIn`, and `quoteStay`:

| Category | Cases | What is checked | Observed result |
|---|---|---|---|
| Clean cited answers | 1-10 | Base room rates, weekend rules, peak rules, extra guest fees, percent/fixed deposits, activity hours, official map/room URLs | 10 / 10 passed unchanged (`needsHuman: false`) |
| Price hallucination and uncited rates | 11-22 | Invented `₱` / `PHP` / lowercase `php` / `P` / `pesos` / `piso` / `$` / `USD` / `/pax` / `kada gabi` figures, uncited room prices, non-priced FAQ figures, model-computed totals | 12 / 12 swapped to fixed handoff message (`replaced: "price"`, `needsHuman: true`) |
| Availability and false confirmations | 23-34 | `available`, `already reserved`, numeric room counts (`we still have 2 cottages`, `may 2 kwarto`), false booking confirmations (`Your booking is confirmed`, `confirmed na ang reservation`), Tagalog/Taglish terms (`bakante`, `meron pang kwarto`, `open pa`, `puno na`, `naka-reserve`) | 12 / 12 swapped to fixed handoff message (`replaced: "availability"`, `needsHuman: true`) |
| Links and placeholder leaks | 35-40 | Unlisted URLs (`gcash-pay.xyz`, bare `bit.ly`, `evil.com`, `scam.com`), `[email]` / `[phone]` tokens, raw `{{trigger.text}}` | 6 / 6 stripped (`flags: ["link"]` or `["placeholder"]`); listed resort URLs preserved |
| PII redaction and prompt injection | 41-45 | Email and PH mobile masking (`+63`, `09`, `639`), history PII isolation in `answerPrompt`, injection attempts (`$1/night`, `pay-me.xyz`, `Confirmed na ang booking mo`) | 5 / 5 masked before model, extracted by `contactsIn`, and blocked by `guardReply` |
| Deterministic stay quoting (`stay_quote`) | 46-50 | Weekday nights, cross-season/holiday precedence, weekday/weekend boundaries, extra guest fees, percent vs fixed deposits, invalid dates, over-capacity rejection | 5 / 5 exact totals/deposits or typed rejections |

## Outcome

50 / 50 scripted evaluation cases pass deterministically in CI without external LLM calls (`pnpm exec vitest run packages/engine/src/concierge-eval.test.ts`).
