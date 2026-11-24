# Resort concierge plan

Written 22 November 2026 against `main` at aeb8d7c (migrations to 0047, decisions to 0104). I2 (Shopify) is open and may take the next migration and decision numbers, so the numbers below are placeholders until merge time. Nothing here is built yet.

## What the resort asked for

1. Instant reply within seconds, 24/7, in English and Taglish, with menu buttons (rooms, rates, location, activities).
2. Inquiry capture: dates, number of guests and contact details into Google Sheets, with a staff alert.
3. Deposit instructions: GCash or bank details sent automatically, with a reminder if no payment proof arrives.
4. A follow-up 24 hours later to anyone who asked but did not book.
5. A pre-arrival message: directions, check-in time, what to bring.
6. A review request on Google or Facebook after checkout.

Channels asked for: Messenger, WhatsApp, Viber and email.

## What works today, mapped to the six asks

Checked in the code on 22 November 2026.

| Ask | What exists | What stops it today |
|---|---|---|
| 1. Instant reply | `meta_dm` trigger and `POST /hooks/meta/:path` with signature check and `mid` dedup (`apps/api/src/public.ts:254`, `packages/db/src/meta.ts:88`). `meta_reply` step, text only, recipient pinned to the sender (`apps/worker/src/steps/index.ts:382`). AI step with classify, extract, summarize and draft, image input (`packages/engine/src/ai.ts`). Email-in trigger over IMAP (`apps/worker/src/email-in.ts`). Taglish copy for six templates (`packages/engine/src/taglish.ts`). | One run per message with no memory of the conversation. No buttons: the send body is `{ text }` only and the parser drops postbacks and quick-reply payloads. The AI step has no knowledge input; `instructions` is 2,000 characters of fixed text. Email-in polls every 60 seconds, so email replies take up to about a minute. Email replies are not threaded (no `In-Reply-To`). |
| 2. Inquiry capture | AI `extract`, `sheets` append, `telegram`, `slack`, `email`, `discord` alerts, all as queued deliveries with retry rules. | Dates and guest counts often arrive across several messages; each message is its own run, so a row cannot be built from the whole conversation. |
| 3. Deposit and reminder | R3: `payment_due` makes a due with a pay page (`/pay/:token`) showing the QR Ph code or GCash number, Receipts to review, nudges built from delay, `payment_status` and a condition, `payment_expire`, `confirmedMessage` by SMS or Messenger. | A deposit needs a trusted amount: M4 (decision 0102) refuses `{{trigger.*}}` from a DM, but L7 says a price taken from a step output is not followed, so an AI-extracted number could reach `amount`. A receipt photo sent in Messenger cannot become a claim on the due; only the pay page can. The confirmation by Messenger fails if it lands outside the 24-hour window. |
| 4. Follow-up | `delay` and `condition` steps, `meta_reply`. | The window check measures from the message that started the run (`deliveries.ts:249`), and a newer message from the guest does not cancel the older run's follow-up. |
| 5. Pre-arrival | `delay until` with `offsetSeconds` (start minus two days works), `email`, `sms` (UniSMS, operator-level, U6), bookings with an exclusion constraint. | A booking is at most 1,440 minutes (`definition.ts:165`), so a multi-night stay cannot be booked. A booking stores no guest contact. Messenger is closed outside the 24-hour window. |
| 6. Review request | Same delays and messages. | Same stay limit. No "checked out" state; the end of the stay range is the nearest signal. |

Also in place and reused: approvals, conditions, R5 morning digest, R6 customer export and delete, U5 library with categories, N6 quotas, `run_keys` dedup, the booking-version supersede pattern (decision 0032).

Not in place: any WhatsApp or Viber code (only a test that rejects `channel: "viber"`). The live Meta check (`docs/live-meta-check.md`) has never been run and Meta App Review for `pages_messaging` and `instagram_manage_messages` is not done, so today only Page testers can message the bot.

## Gaps and their designs

### (a) Conversation memory per guest

New tables `conversations` and `conversation_messages` (see Data model). The Meta webhook and email-in upsert the conversation and append the inbound message in the same transaction that creates the run. The run's trigger payload gains `conversation.id`, `conversation.status`, `conversation.fields` (dates, guests, name, phone, email gathered so far) and `conversation.history` (last 10 messages, capped at 4,000 characters).

Runs of one conversation are ordered the way booking versions are: each inbound message raises `conversations.version`, and a run linked to an older version stops at its next step. Two messages a second apart therefore give one reply to the latest state, and a newer message cancels a waiting follow-up for free.

A new step `conversation_update` saves extracted fields into `conversation.fields` (merge, field list fixed, values length-capped) so the next message's run sees them.

The 24-hour window is measured from `conversations.last_inbound_at`, not from the run's first message. `meta_reply` gets two extra edges checked before it queues: `outside_window` and `paused` (staff took over), so a template can fall back to SMS or email instead of failing.

### (b) Menu buttons

Messenger quick replies (up to 13, title up to 20 characters) and postback buttons. `meta_reply` gains `quickReplies: [{ title, choice }]`, where `choice` is a fixed id from a list (`rooms`, `rates`, `location`, `activities`, `book`, `staff`). The webhook parser reads `message.quick_reply.payload` and `postback.payload` (the app subscribes to `messaging_postbacks`) and exposes `trigger.choice`; any payload not in the list is dropped. A tapped button routes through a condition to a fixed answer from the knowledge sheet, so it costs no AI action and answers in about a second. Instagram quick-reply support and limits are unverified and get checked in the live Meta check. Email gets the same menu as a short numbered list.

A persistent menu and a Get Started button are Page settings. They are left to C2's stretch goal because the resort can also set them in Meta Business Suite.

### (c) Knowledge sheet

A Knowledge page under Business, owner and operator only. Entries have a kind (room, rate, fee, faq, policy, location, activity, arrival, review_link), a title, plain text, and for rooms and rates structured fields: room name, capacity, price per night in pesos, extra guest fee, season start and end, deposit percent or fixed deposit. Publishing saves an immutable `knowledge_versions` snapshot, like workflow versions, and each AI answer records which version and entries it used. CSV import is a later nicety; the console form is enough for one resort.

Storing it in kymavo, not in a Google Sheet the bot reads, keeps prices under the owner's console and versioned, and needs no new Google read scope.

### (d) WhatsApp Cloud API

Kept as N25, built only if the resort picks WhatsApp and accepts the cost (C10). It needs Meta Business verification, a phone number for the Cloud API, a payment method on the resort's Meta business account, and approved message templates for anything sent outside the 24-hour window. Every WhatsApp message cost is passed to the resort. See Costs.

### (e) Viber

Stays out. Decision 0042 found about EUR 100 a month for a bot account created since February 2024. Viber's current Business Messages rate card lists a monthly minimum commitment in tiers of EUR 115 and EUR 175 plus a per-message rate (unverified which tier applies to the Philippines). The minimum alone is more than four times the USD 25 plan. Revisit only if a resort signs a Viber partner contract and pays it directly.

### (f) Meta's 24-hour window, per message

Meta retired the `CONFIRMED_EVENT_UPDATE`, `POST_PURCHASE_UPDATE` and `ACCOUNT_UPDATE` message tags: requests carrying them return error 100 from 27 April 2026 (from Meta's Send API notice as quoted by several sources; the official page did not render for us, so unverified). `HUMAN_AGENT` still allows a person to reply for 7 days, needs App Review, and must be a human, so kymavo does not use it; staff reply from the Page inbox. Meta's paid Messenger marketing messages are not planned.

| Message | Messenger and Instagram | Email | SMS (UniSMS) | WhatsApp, if added |
|---|---|---|---|---|
| 1. Instant reply | Yes, inside the window | Yes, within about a minute | No | Service message |
| 2. Staff alert | Not to the guest. Staff get Telegram, Slack or email | | | |
| 3. Deposit instructions | Yes when sent within 24 hours of the guest's last message; else falls back | Fallback | Fallback when a phone was given | Utility template |
| 3. Deposit reminder (about 6 hours later) | Same rule | Fallback | Fallback | Utility template |
| 4. Follow-up | At 20 hours after the guest's last message, so it stays inside the window | At 24 hours | Not sent (cost, and unasked) | Not sent |
| 5. Pre-arrival (2 days before) | Only if the guest wrote in the last 24 hours | Yes | Yes when a phone was given | Utility template |
| 6. Review request (1 day after checkout) | Only if the window is open | Yes | Optional | Template, category set by Meta (unverified whether utility or marketing) |

Whether a follow-up nudge inside the window counts as standard messaging under Meta's current policy is unverified; the live Meta check confirms it before the template turns it on.

### (g) Human handoff

`conversations.status` is `bot`, `staff` or `closed`. It turns to `staff` when:

- a staff member presses Take over on the Conversations page;
- the guest taps "Talk to staff" or the AI answer sets `needsHuman`;
- the Page sends a message that our app did not send (an echo without our `app_id`), meaning someone replied from the Page inbox.

While `staff`, inbound messages are stored and alert staff, and no concierge run replies (`meta_reply` takes `paused`). It returns to `bot` when staff press Hand back, or after a quiet period the owner sets (default 12 hours since the last staff message). Staff reply from Meta Business Suite or their mail client; replying from the kymavo console is later.

### (h) Stays (found in the code check)

A `booking` create gains a stay mode: a check-in date, nights (1 to 30), and the resort's check-in and check-out times from the knowledge sheet, so `during` covers the whole stay; `bookings_no_overlap` already handles any length. The booking links to its conversation for the guest contact. Each room unit is a resource; room types are a resource label. A stay is created by staff from the Conversations page (Confirm stay, prefilled from the gathered fields) or after the deposit is confirmed, never from guest text alone.

### (i) Receipt photo in a DM (found in the code check)

When the conversation has an open due and the guest sends an image, the image becomes a claim on that due, exactly as if sent on the pay page: it goes to Receipts to review, gets the duplicate and amount flags, and never marks anything paid.

## Data model and migrations

One migration per phase that needs it, numbered at merge time (I2 may take 0048).

- `conversations`: id, user_id (workspace), channel (`messenger`, `instagram`, `email`), external_id (PSID, IG-scoped id or lowercased email), status, version, fields jsonb, last_inbound_at, last_outbound_at, staff_until, notice_sent_at, open_due_id, created_at. Unique on (user_id, channel, external_id). Test conversations kept apart like test bookings.
- `conversation_messages`: id, conversation_id, direction (`in`, `out`, `staff`), text (capped), mid or message-id (unique per conversation for dedup), run_id, upload ids, created_at.
- `runs.conversation_id`, `runs.conversation_version` (like `booking_id` and `booking_version`).
- `knowledge_entries` (draft rows) and `knowledge_versions` (immutable published JSON, version number).
- `bookings.conversation_id`, nullable.
- Workspace settings: conversation retention days (default 90), staff quiet period (default 12 hours).

Every new table is added by hand to `collect()`, `deleteCustomer()` and `keptOf()` in `packages/db/src/privacy.ts`; R6 does not pick tables up automatically.

## Guest data privacy (RA 10173)

- Notice: the first reply in every new conversation says it is an automated assistant, what is collected (dates, number of guests, name and contact) and why, that messages are processed by the resort's AI provider, and links to the resort's privacy notice. Sent once per conversation (`notice_sent_at`). Today the DM path shows no notice, which the R6 roadmap item promised.
- Collect only what a reservation needs. The bot never asks for IDs, card numbers or health details, and tells guests not to send ID photos.
- Minimise what reaches the model: emails and phone numbers are replaced with placeholders before the model call and found with fixed patterns instead, as N4f does for team addresses. Only the last 10 messages go.
- Retention: message text is deleted by the worker sweep a set number of days after the conversation's last message (default 90, owner adjustable). Fields that a stay or payment needs stay with those records under R6's `keptOf` rules.
- R6 export and delete must cover conversations and their messages. A Messenger guest often gives no email, so the Conversations page gets "Export this guest" and "Delete this guest" by conversation, and the email and phone search also matches `conversations.fields`. L2 (identifier in the query string) moves to a POST before the pilot, as already planned.
- Access: owner and operator see conversations; approvers and requesters do not.
- Copies in Sheets, Telegram, Slack or email are outside kymavo's reach, as R6 already says. The staff alert carries the guest's first name, dates and a console link, not the full conversation.
- kymavo provides the tools; the resort remains the personal information controller and keeps its own duties.

## AI safety rules

1. Prices, rates, fees, discounts and deposit amounts come only from the published knowledge version. A deterministic guard (`guardReply`, code, tests first) checks every peso figure and every number next to words like night, pax, person or room against the entries the model cited. Any mismatch, or a figure with no cited entry, replaces the reply with a fixed "Our team will confirm the rate" message and alerts staff.
2. Availability: the bot never says a room is available, free, fully booked or reserved, in English or Tagalog ("bakante", "may slot", "puno na"). The guard replaces such a reply with "I'll check with the team". Live availability from kymavo stays is out of the pilot, since the resort may also sell on other channels.
3. A booking is confirmed only by a reviewer's or PayMongo's payment decision, or by staff confirming the stay. The confirmation text is a fixed template sent by that event, never model output.
4. The deposit amount comes from the `stay_quote` step (nights times the knowledge rate, deposit rule from the knowledge sheet) or a fixed amount. `payment_due` refuses amounts that read an AI step's output, closing L7 for AI.
5. Guest text is data: it stays in the delimited user message, and the reply goes only to the sender (existing check). The guard strips any link that is not the pay link or a link stored in the knowledge sheet.
6. Handoff on: a request for a person, complaints, refunds, cancellations, medical or safety words, or `needsHuman`. The bot then sends a fixed "A staff member will reply here" and goes quiet.
7. Replies match the guest's language (English, Tagalog or Taglish), up to 640 characters, followed by the menu.
8. Before live guests: measure on 50 scripted conversations in English and Taglish (the `docs/ai-ask-measurement.md` pattern), record every guard replacement, and keep the AI answer off until the owner reads the results. Menu answers work without the model.

## Costs per channel

| Channel or service | Cost | Who pays |
|---|---|---|
| Messenger, Instagram DMs | Free for standard messaging. Needs Meta App Review. | Nothing |
| Email (Gmail app password, Outlook, SMTP) | Free; Gmail and Outlook daily caps apply | Nothing |
| Google Sheets, Telegram, Slack, Discord alerts | Free | Nothing |
| SMS through UniSMS | Per message, from the operator's UniSMS account; quota 50 (Pilot), 300 (Business), 1,500 (Business Plus) a month. Rate per SMS unverified. | Passed to the client in the subscription |
| WhatsApp Cloud API | Billed per delivered message since 1 July 2025. Since 1 October 2026 service replies are also charged after 1,000 free a month per business number; templates are charged per message. The Philippines is in Meta's "Rest of Asia Pacific" market (confirmed on Meta's pricing page). Rates unverified: Infobip lists about USD 0.015 for utility and USD 0.116 for marketing, which may include its markup. Needs a payment method on the resort's Meta account. | The resort, directly to Meta |
| Viber bot | About EUR 100 to 175 a month minimum plus per message (unverified for the Philippines) | Out of scope |
| AI model | Per token on the workspace's provider. Each free-text guest message is one AI action; a resort with 30 conversations a day could use 3,000 or more a month, against 500 on Business. Menu taps use none. | Open question for pricing |
| PayMongo GCash checkout | PayMongo's fee per payment (unverified current rate); needs the resort's PayMongo verification | The resort |

## Resort concierge template set

Three workflows, so the set fits the Business plan's five live automations. Library category: "Resorts and hotels". English, Tagalog and Taglish copy for every guest message.

1. Concierge for Messenger and Instagram (trigger `meta_dm`): skip if staff took over; if a menu choice, answer from the knowledge sheet; else AI answer with the guard; save fields; reply with the menu; when dates, guests and a contact are first complete, add a Sheets row and alert staff (Telegram, Slack or email); if the guest asked to book, alert staff with a "Send deposit request" link; then wait 20 hours and, if the conversation has no newer message and no due, send one follow-up. A newer message ends this run at its next step.
2. Concierge for email (trigger `email`): the same, threaded replies, follow-up at 24 hours.
3. Deposit and stay (started by staff from the Conversations page): `stay_quote`, `payment_due` with the pay link, sent by Messenger inside the window or else SMS or email; reminder after 6 hours; `payment_expire` after the resort's deadline (default 48 hours); on confirmation, the fixed confirmation and the stay booking; pre-arrival 2 days before check-in by email and SMS (Messenger if open); review request 1 day after check-out with the Google and Facebook links, sent to every guest (Google forbids asking only happy guests).

## Phases

Lanes that can run at the same time: A (C1, then C2, then C7), B (C3, then C4), C (C5). C6 starts after C1. C8 needs C1 to C7. C9 follows. C10 (WhatsApp) comes after C9.

| Phase | What | Model | Tests |
|---|---|---|---|
| C0 | Owner, now and in parallel: run `docs/live-meta-check.md`, start Meta App Review, decide whose Meta app the resorts connect to, turn off Meta Business Suite instant replies on the Page so the guest does not get two answers. | Owner | The live check's 12 steps |
| C1 | Conversation state: tables, upsert in the Meta webhook and email-in, version supersede, window from `last_inbound_at`, `outside_window` and `paused` edges on `meta_reply`, echo detection, `conversation_update` step, notice once, retention sweep, R6 export and delete coverage. | Opus 5.5, high | Tests first: two messages in one second give one reply; a newer message ends the older run's follow-up; window edges at 23:59 and 24:01; echo from the Page inbox pauses the bot, our own echo does not; replayed `mid` adds nothing; R6 export and delete include messages; sweep deletes text after the retention days |
| C2 | Menu buttons: `quickReplies` on `meta_reply`, quick-reply and postback parsing with a fixed choice list, `trigger.choice`, numbered menu for email. Stretch: Get Started and persistent menu from Apps. | Opus 5.5, high (signed webhook parser) | Unknown payload dropped; signature still required for postbacks; 13-button and 20-character limits; a tap starts one run |
| C3 | Knowledge page and `knowledge_versions`, owner and operator only. | Sonnet 5.5, high | Role matrix rows; publish makes an immutable version; an edit after publish does not change the version in use |
| C4 | Guarded answers: AI task `answer` (knowledge plus history, output `{reply, entryIds, intent, needsHuman, fields}`), `guardReply`, placeholder redaction, `stay_quote` step, L7 fix for `payment_due`. | Opus 5.5, high | Tests first: invented price replaced; price from an uncited entry replaced; availability words in English and Tagalog replaced; foreign link stripped; quote for 2 nights across a season boundary; `payment_due` refuses an AI output amount; model sees no email or phone |
| C5 | Stays: booking stay mode (date plus nights, times from knowledge), `bookings.conversation_id`, Confirm stay. | Opus 5.5, high | Overlap across nights refused; reschedule keeps nights; pre-arrival delay lands at check-in minus 2 days in Asia/Manila |
| C6 | DM receipt photo as a claim on the conversation's open due; email reply threading (`In-Reply-To`, `References`). | Opus 5.5, high (payment boundary) | Photo makes one claim and marks nothing paid; duplicate reference flagged; no open due means no claim; threaded headers present |
| C7 | Conversations page: Needs staff first, history, Take over, Hand back, edit fields, Send deposit request, Confirm stay, Export and Delete this guest; digest counts conversations waiting for staff; staff alert by Messenger with a Telegram or email fallback when the staff member's window is closed. | Sonnet 5.5, high | Playwright at 390 px and desktop; role matrix; English and Tagalog |
| C8 | The three templates, Taglish copy, library category, setup guide lines. | Sonnet 5.5, medium | Template definitions parse and lint clean; sample test runs on fake providers cover a menu tap, a priced question, a handoff and a follow-up |
| C9 | Security review of C1 to C8 and the 50-conversation measurement; threat model sections for conversations and knowledge. | Opus 5.5, high | Review findings each with a failing test before the fix |
| C10 | WhatsApp Cloud API (N25): inbound webhook, service replies, utility templates for deposit reminders and pre-arrival, cost note in the UI. Starts once the resort's Meta business account is verified with a payment method. | Opus 5.5, high | Fake Cloud API: webhook signature, template send outside the window, cost note in the UI |

Each phase follows the usual rules: plan and the owner's "go", tests first for the logic named above, `docs/how-it-works.md`, `docs/threat-model.md` and a decision record updated, one commit per phase.

## Owner answers (22 November 2026)

1. Channels: Messenger, Instagram, email, SMS for pre-arrival, and WhatsApp. Viber stays out. C10 (WhatsApp) is in scope; it starts after C9 and once the resort has a verified Meta business account with a payment method, since every WhatsApp message is billed to the resort.
2. The resort also sells rooms on other channels. The bot never states availability, and staff confirm every stay. kymavo stays drive reminders only.
3. Staff approve each deposit request (Send deposit request on the Conversations page); the amount comes from `stay_quote`.
4. Both payment routes: manual QR Ph and GCash review, and PayMongo checkout. Checkout needs the resort's PayMongo business verification and an owner-run live check (`docs/live-paymongo-check.md`); PayMongo's fee per payment goes to the resort.
5. Staff alerts go to Telegram, email, Slack and Messenger. A Messenger alert to a staff member is new work (C7) and has a limit: Meta's 24-hour window applies to staff too, so it only arrives if that staff member messaged the Page in the last 24 hours. Otherwise the alert falls back to Telegram or email, and the Conversations page says so.
6. AI cost: the operator's model key, sold as a concierge plan above USD 25 with a larger AI allowance. The plan's price and allowance are set before the pilot starts (N6 quota tiers gain a concierge tier in C8).
7. One kymavo Meta app: the owner passes App Review once (C0), every resort connects its Page to it, and the owner holds the app's platform policy duties.
8. Conversations are kept 90 days after the last message, adjustable per workspace.

## Still open

1. Do the resort's rates vary by season, weekday, or per head, and are there day-tour or entrance fees? This sets the knowledge fields and `stay_quote`. Is the deposit a fixed amount or a percent?
2. Who reviews receipts?
3. The bot's name and tone in Taglish, and the Google and Facebook review links.
4. The concierge plan's monthly price and AI allowance.

Sources checked on 22 November 2026: Meta's WhatsApp pricing pages (developers.facebook.com/documentation/business-messaging/whatsapp/pricing), Meta's Send API message tags page (did not render; tag dates from third-party notices), Viber's Business Messages rate card (forbusiness.viber.com), Infobip's WhatsApp and Viber price pages.
