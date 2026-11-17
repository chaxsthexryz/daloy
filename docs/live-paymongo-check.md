# Manual live PayMongo check

The automated tests never contact PayMongo. They use a fake server and signed test events. This page is the separate check against a real PayMongo account. Run it by hand. Never paste a key or a webhook secret into a ticket, chat or this file.

Status: not run yet. Record the date, the Daloy commit and what you saw at the end of this file when you do.

## Part 1: test mode (test keys)

Before you start: a PayMongo account (test mode needs no business verification), its test secret key (`sk_test_...`), Daloy running with a public HTTPS address (a tunnel is fine) set as the public URL, and a way to see the worker logs.

1. In Apps, open PayMongo and save the test key with a placeholder webhook secret (`whsk_x`). The webhook URL (`<public URL>/hooks/paymongo/<path>`) appears after the first save. Copy it.
2. In PayMongo, in test mode, go to Developers, Webhooks, and add that URL with the events `checkout_session.payment.paid` and `payment.refunded`. Copy the `whsk_` secret.
3. In Daloy, save again with the real test key and the webhook secret. Select Test. Expect "PayMongo accepted the key".
4. Try a `sk_live_` key. Expect a refusal that says live mode is not switched on.
5. Make two automations. A: a manual trigger and a Create payment link step (amount `150.50`, a description, a reference). B: the trigger "When a PayMongo payment is confirmed", then a visible step (an email to yourself or a Slack note). Publish both.
6. Run A. Expect a payment with a checkout URL and status pending. Retry the step and confirm PayMongo shows one session, not two.
7. Open the checkout URL. Pay with PayMongo's test GCash flow and authorize it. Expect a run of B within a minute with status `paid`, amount `15050` and the reference.
8. In PayMongo, open the webhook's delivery for that event. Check that `Paymongo-Signature` has `t=`, `te=` and `li=`. Daloy accepting it (step 7 ran) shows the signed string `t.body` is right. If it was refused with 401, the other form (body alone) may be the real one: write down which one verifies and fix the code and decision 0045.
9. Resend the same event from the dashboard. Expect Daloy to answer 200 with `duplicate` and no second run of B. Note whether the resent event carries a fresh `t`. If it does, tighten the tolerance in `verifyPaymongoSignature` from 72 hours to 5 minutes and say so in decision 0045.
10. Amount check: make another link, change its `amount_centavos` in the database to a different number, then pay it. Expect the payment in needs_review and no run of B.
11. Refund the payment in the PayMongo dashboard (test mode). Expect a `payment.refunded` event, the payment `refunded`, and a run only for automations that listen for refunded.
12. Open a checkout page and leave without paying. Expect the payment to stay pending.
13. Search the run history and worker logs. Expect no secret key and no webhook secret.

## Part 2: live mode

Only after PayMongo business verification is approved.

1. Set `PAYMONGO_LIVE=on` on the server and restart. In PayMongo's live mode make a separate webhook with the same URL and events, and copy its secret. Events whose mode differs from the connection are refused.
2. In Daloy, save the `sk_live_` key and the live webhook secret. Select Test.
3. Create a link for a small amount (for example 20.00). Pay it with a real GCash or Maya account you own. Expect the follow-up run, the payment `paid`, and the same signature check as in part 1.
4. Refund it in the PayMongo dashboard. Expect `refunded`.
5. If you do not need live mode afterwards, turn `PAYMONGO_LIVE` off. Roll the live key if it was shown on a screen you shared.

## Results

None recorded yet.
