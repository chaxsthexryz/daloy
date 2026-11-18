# Try every feature

A hands-on tour of everything Daloy does as of 18 November 2026 (main at `ccb9c8e`). Each mission builds one real automation and touches several features. At the end there is a checklist: tick each box as you see it work, and write down anything confusing, slow or wrong.

Your data is safe: none of this resets the database. Mailpit at http://localhost:8025 catches every email the local stack sends, so nothing reaches a real inbox unless you connect a real Gmail or Outlook.

## 0. Before you start

1. Start the stack: `docker compose up -d --build` in the daloy folder, then open http://localhost:3000.
2. Open Mailpit in a second tab: http://localhost:8025.
3. Pick an AI model in Settings, then AI model, and press Test:
   - **DeepSeek** (your key) works for everything except reading photos.
   - **Gemini API** (free key from Google AI Studio) works for everything, including photos. Use it for Mission 7.
   - **Local model** (your llama.cpp Qwen) works for text. It is slow on a CPU, and most small local models cannot read photos.
4. For the "Ask what happened" button, `.env` needs `AI_ASK=on`. Keep it `off` on anything public.
5. Make a second email address you control, for example `you+client@gmail.com`, to play the customer. With Mailpit, any made-up address works.

What needs a real account, and what does not:

| Works on your PC with no outside account | Needs a real account or key you type in yourself |
|---|---|
| Forms, webhooks, schedules, email-in to a local mailbox, approvals, delays, conditions, AI steps, bookings, CSV, brand kit, tokens, pause, cancel, password reset (in Mailpit) | Gmail or Outlook sending, Google Sheets, Drive and Calendar (service account), Slack, Teams, Telegram bot, PayMongo test keys, Airtable, Notion, Trello |

Skip the right-hand column if you don't want to connect those yet. Every mission says which parts need an app.

## Mission 1: your account and workspace

Features: sign-up, password change, password reset, appearance, language, brand kit, team invite, roles.

1. Sign out, then on the sign-in page choose Create an account instead and make a throwaway account. Sign out again and sign back in with your main account.
2. Settings: switch Appearance to Dark, then System. Reload and check it stays.
3. Settings: switch the language to Tagalog, look around the menu and an automation, then switch back.
4. Settings, Business: set a business name, upload a logo (PNG, JPEG or WebP, small), and pick an accent colour.
   - Try uploading an SVG or a renamed file. It must be refused.
5. Account: change your password. It asks for the current one. Any other browser where you were signed in is now signed out.
6. Sign out and use Forgot password. Check Mailpit for the reset link, open it, set a new password, and sign in.
   - Use the same link a second time. It must not work.
   - Ask for a reset for an address that has no account. The page says the same thing, and no mail arrives.
7. Team: invite your second address as an operator. Open the invite from Mailpit in a private window and accept it. As the operator, check you cannot save automations, create API tokens or see Settings meant for owners.

Check: the logo and colour show on public forms and emails in the later missions.

## Mission 2: Build with AI, chat style

Features: Build with AI chat, starter chips, questions only when needed, the summary card, Turn it on, Save as draft, lint warnings.

1. Open Build with AI. On the empty page, tap a starter chip (Freelancer, Small shop, Salon or Virtual assistant). It fills the box and sends nothing.
2. Clear it and type something vague: "Help me with my customers." The AI should ask a short question.
3. Then type something detailed:

   > When a client fills in my inquiry form with their name, email and what they need, email them a thank-you, and email me a summary. If they say it's urgent, I want to approve before the reply goes out.

4. Watch the Thinking indicator, then the summary card: who gets what and when.
5. Press Change something and ask: "Also wait 2 days and send a follow-up if I haven't replied."
6. Press Save as draft. Open Automations: it sits under Drafts and is not live.
7. Do it again with another prompt and press Turn it on this time. It goes live only after that press.

Check: nothing went live before Turn it on. Note how many questions it asked, and what you had to fix by hand in the editor.

## Mission 3: website inquiry, with approval and a public form

Features: guided template, form trigger, Copy form link, Copy embed code, AI classify, condition, approval by email, delay, email step, Needs you, run page, path diagram.

1. New automation, then Inquiry triage. Set the AI labels to `urgent` and `normal`.
2. Urgent branch: an approval step (approver: you), then a reply email. Normal branch: a reply email at once, a 2-minute delay, then a follow-up email.
3. Turn it on. Press Copy form link and open it in a private window. Check your logo and colour are there.
4. Send two inquiries: "Our system is down, customers cannot pay" and "What are your opening hours?"
5. The urgent one shows Needs you. Open Mailpit, find the approval email, and approve it from the link.
6. Copy embed code, save this as `test-site.html` on your desktop with the code inside the body, open it in a browser, and send a third inquiry from there:

   ```html
   <!doctype html><html><body><h1>My shop</h1><!-- paste the embed code here --></body></html>
   ```

Check: the urgent reply only lands in Mailpit after your approval, the normal one gets a follow-up 2 minutes later, and the run page's path diagram shows the branch each took.

## Mission 4: purchase request with two approvals, then CSV

Features: the Purchase request guided template, number condition, two approvals in a row, rejection branch, Activity filters and search, CSV export.

1. New automation, then Purchase request. Add a condition: amount greater than 5,000.
2. Over 5,000: approval by your operator (from Mission 1), then by you, then an "approved" email. Up to 5,000: the "approved" email straight away. On a rejection, email the reason.
3. Send three requests: 1,200, 18,000 (approve both), and 25,000 (reject at the second approval).
4. Automations: use the filters (Needs you, Problem, Waiting) and the search box.
5. Open the automation's Activity and press Download CSV. Open the file in Excel or Google Sheets.
   - Send one more request with the name `=1+1`. In the CSV it must show as text, not as 2.

Check: each request ends in the right state, Mailpit has exactly one outcome email per request, and the CSV columns match the Activity page.

## Mission 5: salon bookings, reminders, Calendar and CSV

Features: booking trigger, Bookings page, reminders, cancel, no-show follow-up, Google Calendar sync (optional), Bookings CSV.

1. New automation, then Lead to booking (or Appointment reminder). Set the reminder to 5 minutes before, so you can watch it.
2. Optional, needs Google: in Apps, connect Google Calendar and add a calendar step.
3. Turn it on. Book one slot about 10 minutes from now and a second slot for later.
4. Bookings: cancel the second slot.
5. Press Download CSV on Bookings.
6. Set up the Booking no-show follow-up template, turn it on, and change its 1-hour delay to 1 minute for the test. Wait until the first booking's time has passed, open Bookings, press Mark no-show on it and confirm. (The button only shows for a booking whose time has passed; Undo no-show works until the follow-up email has gone out.)

Check: both bookings get a confirmation, the first gets its reminder about 5 minutes before, the cancelled one never gets a reminder (and its Calendar event is gone, if connected), and the no-show gets the rebooking email about a minute after you press the button, and pressing it twice sends only one.

## Mission 6: online shop order with payment

Features: the Order to Sheets with payment link, Order paid, Quote approval with deposit and Invoice with payment link templates; PayMongo link and payment_status steps; Google Sheets; payment webhook trigger.

Needs PayMongo test keys (Apps, PayMongo) and optionally Google Sheets. Without them, read along and skip to Mission 7.

1. New automation, then Order to Sheets with payment link. Connect the sheet and PayMongo in Apps.
2. Turn it on, place an order from the form, and open the payment link from Mailpit.
3. Pay with a PayMongo test card from PayMongo's test docs.
4. Turn on Order paid as well. The order is marked paid only when PayMongo confirms, never from a screenshot or reference number.
5. Try Invoice with payment link and reminders: reminders stop once it is paid.

Check: the sheet row appears once, the "paid" email comes only after the test payment, and reminders stop after payment.

## Mission 7: receipt photo to expense row

Features: file upload on forms, file type checks, Google Drive step, AI reading an image or PDF, approval, file download from the run page, 7-day retention.

Use **Gemini** in Settings, AI model for this one. DeepSeek and most local models cannot read photos, and the step tells you so plainly.

1. New automation, then Receipt to expense row. In the AI step, tick the receipt file field so the AI may read it.
2. Optional, needs Google: in Apps, connect Google Drive to a folder in a shared drive, and connect Sheets for the expense row.
3. Turn it on. From the form, upload a phone photo of a real receipt. Then upload a PDF invoice.
4. Try a bad upload: a `.txt` file renamed to `.jpg`, a file over 5 MB, and more than 5 files. Each must be refused.
5. Approve the expense from Mailpit.
6. On the run page, download the file you uploaded.

Check: the AI pulled out the shop and the amount, the file is in the Drive folder, the row is added only after approval, and an AI step without the file ticked never sends the photo.

## Mission 8: ready-made templates tour

Features: every remaining starter template, plus the template list itself.

Open New automation and set up each of these once. Change the text to suit you, turn it on, run it once, then pause or delete it:

| Template | What to try |
|---|---|
| Invoice follow-up | Enter an invoice due in a few minutes; mark one paid before its reminder |
| Booking no-show follow-up | Done in Mission 5, step 6 |
| Appointment reminder | A reminder 5 minutes before |
| Client request to Sheets | A row per request (needs Sheets) |
| Quote approval with deposit | Approve one quote, decline one, and let one time out |
| Renewal reminders | A sheet of domains, hosting and permits; set one due in 30 days to see the mail |
| Shopify or WooCommerce orders | Send the sample order from Mission 9's webhook steps as if it came from your shop |
| Office requests (Set up for my office) | The guided office setup from New automation |

## Mission 9: webhooks, the signature and the timestamp

Features: webhook trigger, signing secret, `X-Daloy-Timestamp`, the 5-minute replay window, "Require the timestamp", HTTP step, failure explanations.

1. Save a signing secret. Open Advanced, then Secrets. Name it `shop_hook`, paste a long random value of your own into Value and press "Save secret". The field clears at once and the value can never be read back, so keep your copy for step 3. (Replace changes it later; Delete asks first.)
2. New automation with a webhook trigger. Set "Signing secret name" to `shop_hook` and copy its URL.
3. Add an AI step: "From this message, return the customer name, item and quantity." Then an HTTP step that posts to `https://example.invalid/orders` (this address never works, on purpose), then an email to yourself.
4. Turn it on. Send a signed order from Git Bash (put in your URL and secret):

   ```bash
   URL="PASTE_WEBHOOK_URL"; SECRET="PASTE_SECRET"
   body='{"message":"Hi, this is Ben. I need 3 boxes of A4 paper."}'
   t=$(date +%s)
   sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
   curl -X POST "$URL" -H "Content-Type: application/json" -H "X-Daloy-Timestamp: $t" -H "X-Daloy-Signature: sha256=$sig" -d "$body"
   ```

5. Send it again with `t=$(( $(date +%s) - 600 ))`, which is 10 minutes old. It must get a 401.
6. Tick "Require the timestamp (recommended)" on the trigger. An old-style call with no timestamp is now refused too.
7. Open the run that stopped at the HTTP step. Read "Why it stopped", press "Explain in simpler words" (uses 1 AI action), and, with `AI_ASK=on`, try "Ask what happened".
8. Change the HTTP URL to a test address you trust, or delete the step, and press Retry.

Check: the signed call starts a run, the stale and unsigned calls are refused, and the explanation is in plain words.

## Mission 10: schedules, the watchdog, pause and cancel

Features: schedule trigger, the schedule watchdog, pause, resume, cancel a waiting run.

1. New automation with a schedule every 5 minutes, a 10-minute delay, then an email.
2. Turn it on and let it fire once. On Activity, open the run waiting on its delay and press Cancel. It stops and sends nothing.
3. Press Pause on the automation. Wait past the next 5-minute mark: no new run starts, and it is not flagged as missed.
4. Resume it. Then, to see the watchdog, stop the worker for a while:

   ```bash
   docker compose stop worker
   ```

   Wait past two scheduled times, then start it again with `docker compose start worker`.

Check: Automations shows "Missed its schedule", one email arrives in Mailpit (at most one per automation per day), and the flag clears after the next good run.

## Mission 11: every app connection

Features: the Apps page, search, Connected filter, each app's own setup, Retry and Post again on deliveries.

Open Apps. For each app you have an account for, press Connect, follow its own setup, then add its step to a small manual automation and press Run:

| App | Step to try |
|---|---|
| Gmail or Outlook | Send an email from your own mailbox, not the built-in sender |
| Google Sheets | Add a row |
| Google Calendar | Create, then move, then cancel an event from a booking |
| Google Drive | Save a form file (Mission 7) |
| Slack | Post a message to a channel |
| Microsoft Teams | Post to a channel |
| Telegram | Send a message from your bot |
| PayMongo | A payment link (Mission 6) |
| Airtable | Add a record |
| Notion | Add a page |
| Trello | Add a card |

For one of them, break it on purpose (disconnect the app, or use a wrong channel), run the automation, then fix it and press Retry on the failed delivery. Try Post again on a delivered one.

Check: Connected shows the right count, a failed delivery says why in plain words, Retry sends once, and no app key ever shows on screen after you save it.

## Mission 12: email-in, tokens, MCP and limits

Features: email-in (IMAP) trigger, API tokens with scopes and expiry, MCP with Hermes Agent, usage view, quotas, the daily send cap.

1. **Email-in:** make an automation with the email-in trigger and point it at a mailbox (Settings explains each field). Send that mailbox an email and watch a run start.
2. **API tokens:** in Advanced, API tokens, create three tokens:
   - one with only "read runs"
   - one with "run workflows"
   - one with an expiry date of tomorrow

   Copy each once; they are not shown again.
3. **MCP:** tokens work on the MCP server only. In Hermes Agent, add the MCP server `http://localhost:3000/mcp` with the header `Authorization: Bearer dly_...` and the "run workflows" token. Ask: "List my Daloy automations", then "Run the website inquiry automation with a test inquiry from Ana about a broken printer." Check the run appears in Activity.
4. **Scopes:** swap Hermes to the read-only token and ask it to run the same automation. It must be refused, while listing still works.
5. **Usage:** Settings, Plan and usage. Every AI call from the missions above is counted.
6. **Send cap (optional):** set `MAILBOX_DAILY_CAP=2` in `.env`, run `docker compose up -d`, and send three emails through your connected Gmail or Outlook. The third waits under Needs you with a plain reason and is not lost. Remove the line afterwards and run `docker compose up -d` again.

Check: tokens do only what their scope allows, the expired one stops working tomorrow, and usage numbers add up.

## Checklist

Tick each as you see it work. "Notes" is for anything confusing, slow or wrong.

| Area | Feature | Mission | Works | Notes |
|---|---|---|---|---|
| Account | Sign up, sign in, sign out | 1 | [ ] | |
| Account | Change password, other sessions signed out | 1 | [ ] | |
| Account | Forgot password, single-use link | 1 | [ ] | |
| Account | Team invite and operator limits | 1 | [ ] | |
| Settings | Light, Dark, System | 1 | [ ] | |
| Settings | English and Tagalog | 1 | [ ] | |
| Settings | Brand kit on forms and emails | 1, 3 | [ ] | |
| Settings | AI model presets and Test | 0 | [ ] | |
| Settings | Plan and usage | 12 | [ ] | |
| Build | Build with AI chat, questions, summary, Turn it on | 2 | [ ] | |
| Build | Guided templates (office, purchase, inquiry) | 3, 4, 8 | [ ] | |
| Build | All ready-made templates | 8 | [ ] | |
| Build | Editor, Check before publishing, Versions | 2 | [ ] | |
| Triggers | Form, link and embed | 3 | [ ] | |
| Triggers | Form file upload and type checks | 7 | [ ] | |
| Triggers | Webhook with timestamp signature | 9 | [ ] | |
| Triggers | Schedule | 10 | [ ] | |
| Triggers | Email-in | 12 | [ ] | |
| Triggers | Booking | 5 | [ ] | |
| Triggers | PayMongo payment | 6 | [ ] | |
| Steps | AI (text) | 3, 9 | [ ] | |
| Steps | AI reads image and PDF | 7 | [ ] | |
| Steps | Condition, delay, approval | 3, 4 | [ ] | |
| Steps | Email | 3 | [ ] | |
| Steps | HTTP | 9 | [ ] | |
| Steps | Payment link, payment status | 6 | [ ] | |
| Apps | Gmail, Outlook, Sheets, Calendar, Drive | 11 | [ ] | |
| Apps | Slack, Teams, Telegram | 11 | [ ] | |
| Apps | Airtable, Notion, Trello | 11 | [ ] | |
| Runs | Needs you, approval by email link | 3 | [ ] | |
| Runs | Path diagram and plain states | 3 | [ ] | |
| Runs | Why it stopped, Explain in simpler words | 9 | [ ] | |
| Runs | Ask what happened (AI_ASK=on) | 9 | [ ] | |
| Runs | Retry, Post again | 9, 11 | [ ] | |
| Runs | Cancel a waiting run | 10 | [ ] | |
| Runs | Pause and resume an automation | 10 | [ ] | |
| Runs | Schedule watchdog | 10 | [ ] | |
| Lists | Automations search, filters, Drafts | 4 | [ ] | |
| Lists | Activity CSV, formula cells escaped | 4 | [ ] | |
| Lists | Bookings, cancel, no-show, CSV | 5 | [ ] | |
| Advanced | API tokens with scopes and expiry | 12 | [ ] | |
| Advanced | MCP from Hermes Agent | 12 | [ ] | |
| Limits | Daily send cap | 12 | [ ] | |

## When you are done

- Set `AI_ASK=off` and `SHARED_LLM_KEY=off` in `.env` before putting this anywhere public, then run `docker compose up -d`.
- Delete or pause the test automations you don't want to keep, revoke the test API tokens, and remove the throwaway account's invite if you made one.
- Send your notes back here; each "confusing" or "wrong" line becomes a fix.
