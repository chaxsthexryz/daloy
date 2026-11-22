# 0102: Pay page limits and where a due's price may come from

## Context

The 22 November security review ([docs/security-review-2026-11-22.md](../security-review-2026-11-22.md)) found three gaps on the R3 payment paths. The pay page read uploads outside the shared multipart budget (M1). One pay link could open references without end and spend the office's upload allowance on repeats and unreadable files (M2). A `payment_due` step could take its amount from a public visitor, so the visitor's own number was what counted as paid (M4).

## Options

- M1: give the pay page its own budget, or share one counter across every multipart route.
- M2: limit claims per IP only, limit open claims per order, or limit claims per order for all time.
- M4: approve every visitor-set amount (as decision 0056 did for the order starter), refuse visitor-set amounts in the definition, or trace values through step outputs.

## Decision

- One byte budget for all multipart routes. `UploadBudget` takes the route's size limit and a lookup that refuses an unknown form or pay link before the body is read.
- At most 5 transfer references open or waiting for the customer on one order (`OPEN_CLAIMS_PER_DUE`). A decided reference frees its place, so a customer who was asked to clarify can still send a new one. The upload is charged inside the claim transaction after the repeat check, only for an image that is stored.
- A `payment_due` amount or total may read `{{trigger.*}}` only from a manual, schedule, payment or signed webhook trigger. Forms, unsigned webhooks, inbound email and direct messages need a fixed amount. The check lives in `definitionSchema`, next to the rule that a public form cannot reschedule a booking, so drafts, publishing, the AI builder and stored definitions all meet it.

## Consequences

- A workflow saved before this change with a visitor-set due amount fails at intake instead of running. No stock template does this.
- A price taken from a step output (an AI step reading a message, a sheet lookup) is not traced. Builders are told to take prices from the owner's own data.
- 5 is a guess for a small shop. A customer with more than 5 references waiting is told to wait for the seller. Raise it if pilots hit it.
- The budget and the per-IP limit are per API instance, as before.
