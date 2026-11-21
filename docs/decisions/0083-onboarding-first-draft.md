# 0083. The last screen makes one draft, once, from the closest existing template

## Context

The last screen creates an editable draft with a sample order. Pressing the button twice, using two tabs or running onboarding again later must open the same draft. The receipt-review template and the payment flows belong to phase R3 and do not exist yet.

## Options

1. Create the workflow from the browser with the existing `POST /workflows` and `POST /workflows/:id/versions`. Two taps race, and a retry after a network error can leave two drafts.
2. Create it in one API transaction that holds a lock on the workspace's onboarding row, and remember the draft's id on that row.

## Decision

Option 2. `POST /onboarding/finish` locks the row (`select ... for update`), returns `{ workflowId, created: false }` if `workflow_id` is already set, and otherwise inserts the workflow, version 1 (unpublished) and the row update in the same transaction. A second request waits for the lock and then sees the id. The API test sends three finishes at the same moment and checks that one draft exists and exactly one response says `created: true`.

Changing an answer afterwards does not rewrite the draft, because the owner may already be editing it. The done page offers "Edit my answers", and finishing again opens the same draft.

The template is the closest one that exists today (`templateFor` in `packages/engine/src/onboarding.ts`):

| Goal | Payment | Template |
|---|---|---|
| Bookings | none | `lead-to-booking` |
| Receipt review | manual QR Ph or pay later | `receipt-expense` (stopgap) |
| Order follow-up | manual QR Ph or pay later | `store-orders` (stopgap) |
| Receipt review or order follow-up | GCash checkout through PayMongo | `order-to-sheets` |

TODO for R3: when the receipt-review and payment-review templates exist, point the two stopgap rows at them. `templateFor` returns `stopgap: true` for those rows, and the unit test lists every row, so the change is one function and one test.

The draft is localised to the workspace language, and the placeholder reviewer address `owner@example.com` becomes the owner's own sign-in address. The sample order is built from the draft's own trigger fields (`sampleOrder`): a fixed customer, 850 pesos, tomorrow at ten for a booking time. File and resource fields are left out, as in the editor's own sample data. The sample is stored with the onboarding row and shown on the done page.

## Consequences

- Nothing is connected, published, sent or invited by onboarding. A test checks that the draft has no published version and no run.
- The editor still builds its own sample trigger data from the fields. Phase R2b can read `sample` from `GET /onboarding` when it adds the sample run.
- The draft name is the template's name, and its slug is `first-workflow` (then `-2`, `-3`) so it never clashes with a slug the owner already uses.
