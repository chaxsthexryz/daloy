# 0127: Concierge security review and 50-conversation measurement (C9)

## Context

With phases C1 through C8 complete, Daloy needed a security review across all concierge, conversation, knowledge, stay, payment, and R6 privacy surfaces plus a reproducible 50-conversation evaluation across English, Tagalog, and Taglish before moving to live resort pilots (C0) or WhatsApp Cloud API (C10).

## Findings and fixes

Each bug or gap found in the review was covered by a failing test before fixing:

1. **USD and `$` price hallucinations bypassed `guardReply`** (`packages/engine/src/concierge.ts`): `PRICES` only matched peso prefixes (`₱`, `PHP`, `Php`, `P`) and peso suffixes. Expanded `PRICES` to catch `$` and case-insensitive `PHP`/`USD`/`dollars`.
2. **Booking confirmation and Taglish numeric room claims bypassed `AVAILABILITY`** (`packages/engine/src/concierge.ts`): phrases such as `"Your booking is confirmed"`, `"confirmed na ang reservation"`, `"already reserved"`, `"we still have 2 cottages"`, `"may 2 kwarto"`, `"meron pang kwarto"`, and `"open pa ang"` were not caught. Expanded `AVAILABILITY` to replace them deterministically with the handoff message and `needsHuman: true`.
3. **Empty `PUT /conversations/settings` body threw a 500** (`packages/db/src/conversations.ts`): Drizzle `.update(users).set({})` fails when no optional setting fields are provided. Added an early return to `conversationSettings` when `set` is empty.
4. **Staff alert sanitization and endpoint rate limits** (`packages/db/src/conversations.ts`, `apps/api/src/conversations.ts`): normalized CR/LF/tab characters and clamped lengths on `firstName`, stay dates, and `reason` inside `sendStaffAlert`, and added `RateLimit(20)` on `sendAlert`, `exportGuest`, and `deleteGuest`.
5. **Exception Content-Type on HTML-annotated handlers and role matrix parity** (`apps/api/src/health.ts`, `apps/api/src/members.test.ts`): `ErrorReportFilter` now forces `.type("application/json")` when returning JSON error payloads so `@Header("Content-Type", "text/html; charset=utf-8")` routes such as `POST /forms/:id` do not return JSON error bodies with `text/html` headers, and added C7/L2/A2 routes (`GET /health`, `/conversations/*`, `POST /privacy/customer/export`) to the role matrix checks.

## Verification

- `packages/engine/src/concierge-eval.test.ts` records 50 scripted EN, Tagalog, and Taglish conversations covering cited answers, price hallucinations, availability/confirmation leaks, foreign link/placeholder stripping, PII masking, prompt injection isolation, and multi-night `stay_quote` rules (`50/50` passed). See [docs/concierge-50-eval.md](../concierge-50-eval.md).
- Audited tenant scoping, role guards (`OPERATE` vs `MANAGE`), L7 payment/stay origin rules, webhook signature and replay guards, and R6 export/delete paths across C1 to C8; recorded updated threats and mitigations in [docs/threat-model.md](../threat-model.md).
