# Manual live UniSMS check

Automated tests never call UniSMS. They use the local fake in `test/fake-providers.ts`. This checklist covers the separate manual check against a real UniSMS account and real Philippine mobile numbers. Never paste a real Secret Key into a ticket, chat, or this file.

Status: not run yet. Record the date, Daloy commit, and observed results at the end of this file when you run it.

## Before you start

- A UniSMS account with loaded SMS credits and its API Secret Key (Basic Auth token).
- Note on Sender ID registration:
  - The default test Sender ID (`Unisoft`) works only on Globe and DITO networks and blocks URLs in message text.
  - A registered custom Sender ID (up to 11 alphanumeric characters) reaches Globe, Smart, DITO, Sun, and TNT and allows links. Registering a custom Sender ID with UniSMS requires a signed Letter of Authorization (LOA) and DTI or SEC registration documents, plus carrier approval time.
- Note on pricing pass-through:
  - Track your actual per-SMS cost in PHP on your UniSMS dashboard (including multi-part segments above 160 GSM-7 characters or 70 UCS-2 characters). Plan limits (`pilot: 50`, `business: 300`, `business_plus: 1500`) are sized so SMS cost is covered by the monthly subscription price.
- A workspace on a paid plan (`pilot`, `business`, or `business_plus`), or a private install with `plan` set to null, so the `sms` monthly limit allows sending (`preview` has `sms: 0`).
- At least one Philippine mobile phone you own (Globe/DITO for `Unisoft`, or Smart/TNT/Sun too once your custom Sender ID is approved).

## Steps

1. In Apps, open UniSMS, paste your Secret Key, enter your Sender ID (`Unisoft` for initial Globe/DITO testing, or your approved custom Sender ID), and press Connect UniSMS. Confirm the page shows Connected and never displays the Secret Key.
2. Enter your own Philippine mobile number in the test box (try `09XXXXXXXXX` format) and press Send a test SMS. Confirm "UniSMS accepted a test SMS" appears, the SMS arrives on your phone with the expected Sender ID, and Settings shows SMS usage incremented by 1.
3. Try entering a non-Philippine number (such as `+14155550100`) and press Send a test SMS. Confirm it is refused with 400 and no SMS is sent or counted.
4. Build a booking automation with a Create booking step, a confirmation Send SMS step, a short delay (for example 2 minutes), and a reminder Send SMS step. Publish it.
5. Run a Mock test from the editor. Confirm no real SMS is sent and no delivery row is created.
6. Run a real booking for your phone number. Confirm the confirmation SMS arrives.
7. Before the 2-minute reminder delay finishes, cancel the booking from the Bookings page. Wait until after the delay window passes. Confirm no reminder SMS arrives on your phone and Activity shows the run closed because the booking changed.
8. Optional operator fallback check: disconnect UniSMS on a `pilot` workspace, set `SHARED_UNISMS_KEY=open`, `UNISMS_SECRET_KEY`, and `UNISMS_SENDER_ID` in the server env, restart, and run one SMS step. Confirm the SMS sends with the operator Sender ID and counts against the workspace's monthly quota. Repeat on a `preview` workspace and confirm it is blocked with 0 SMS sent.
9. Check run history, delivery details, and worker logs. Confirm the Secret Key and its Base64 Basic Auth header never appear anywhere.

## Results

None recorded yet.
