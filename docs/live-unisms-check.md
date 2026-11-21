# Manual live UniSMS check

Automated tests never call UniSMS. They use the local fake in `test/fake-providers.ts`. This checklist covers the separate manual check against a real UniSMS account and real Philippine mobile numbers. Never paste a real Secret Key into a ticket, chat, or this file.

Status: not run yet. Record the date, Daloy commit, and observed results at the end of this file when you run it.

## Before you start

- A UniSMS account with loaded SMS credits and its API Secret Key (Basic Auth token). Only the server operator holds it: it goes in the server env as `UNISMS_SECRET_KEY` with the Sender ID as `UNISMS_SENDER_ID` (both required), never in the console.
- Note on Sender ID registration:
  - The default test Sender ID (`Unisoft`) works only on Globe and DITO networks and blocks URLs in message text.
  - A registered custom Sender ID (up to 11 alphanumeric characters) reaches Globe, Smart, DITO, Sun, and TNT and allows links. Registering a custom Sender ID with UniSMS requires a signed Letter of Authorization (LOA) and DTI or SEC registration documents, plus carrier approval time.
- Note on pricing pass-through:
  - Track your actual per-SMS cost in PHP on your UniSMS dashboard (including multi-part segments above 160 GSM-7 characters or 70 UCS-2 characters). Plan limits (`pilot: 50`, `business: 300`, `business_plus: 1500`) are sized so SMS cost is covered by the monthly subscription price.
- A workspace on a paid plan (`pilot`, `business`, or `business_plus`), or a private install with `plan` set to null, so the `sms` monthly limit allows sending (`preview` has `sms: 0` and is refused).
- At least one Philippine mobile phone you own (Globe/DITO for `Unisoft`, or Smart/TNT/Sun too once your custom Sender ID is approved).

## Steps

1. Set `UNISMS_SECRET_KEY` and `UNISMS_SENDER_ID` (`Unisoft` for initial Globe/DITO testing, or your approved custom Sender ID) in the server env and restart the API and worker. Confirm Apps shows no UniSMS card and the console never displays the key. With either value empty, confirm an SMS step cannot be turned on and the message is "SMS is not set up on this server."
2. Build a one-step automation with a Send SMS step addressed to your own Philippine mobile number (try `09XXXXXXXXX` format), publish it, and run it. Confirm the SMS arrives with the expected Sender ID, that the workspace's SMS usage on Settings went up by one, and that changing the step's Sender ID field does not change the sender.
3. Run the same step with a non-Philippine number (such as `+14155550100`). Confirm it fails as an invalid number and no SMS is sent or counted.
4. Build a booking automation with a Create booking step, a confirmation Send SMS step, a short delay (for example 2 minutes), and a reminder Send SMS step. Publish it.
5. Run a Mock test from the editor. Confirm no real SMS is sent and no delivery row is created.
6. Run a real booking for your phone number. Confirm the confirmation SMS arrives.
7. Before the 2-minute reminder delay finishes, cancel the booking from the Bookings page. Wait until after the delay window passes. Confirm no reminder SMS arrives on your phone and Activity shows the run closed because the booking changed.
8. If a workspace saved its own UniSMS key before decision 0100, restart the worker and confirm `connections` has no `unisms` row, `retired_secrets` has one row for that workspace, and SMS now sends with the server key and Sender ID. Confirm a `preview` workspace is refused with the Preview plan message.
9. Check run history, delivery details, and worker logs. Confirm the Secret Key and its Base64 Basic Auth header never appear anywhere.

## Results

None recorded yet.
