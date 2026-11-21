# Daloy product roadmap

Revised 21 November 2026 from the owner's draft of the same date. Changes from the draft are listed at the end.

The first release lets a Philippine seller set up one workflow on a phone, see what each step does, test it with a sample order, and choose how to confirm payments. A seller who shares a GCash or QR Ph code and a seller who offers PayMongo checkout should both be able to answer "Which orders still need my attention?"

## Release sequence

| Order | Deliverable | Owner acceptance test |
|---|---|---|
| 1 | Short onboarding and a recommended first workflow | A new seller reaches a relevant draft on a phone in three screens. Returning sellers can resume or edit their answers. |
| 2 | App logos, action labels, setup guide and sample run | The seller can say who gets each message, edit it, and explain the flow before switching it on. |
| 3 | Manual QR Ph transfer review and automatic GCash checkout | Demonstrate both routes from order to confirmation. A seller can also choose pay later or no deposit. |
| 4 | Phone step editor, then faster canvas editing | A seller can add, reorder and edit a step on a phone. Canvas: add, connect and undo with touch, keyboard or mouse. |
| 5 | Demand-led extensions | Pilot public-page reading or a marketplace or messaging integration when a merchant names a recurring task. |

Phases 1 to 3 form the first seller pilot. Start phase 2 with a receipt-review template and one automatic-checkout example. Use the existing store-order template to exercise the webhook guide.

## 1. First-time onboarding

One question per screen, visible progress, selectable cards and an easy way back. Use Daloy's blue, its own icons and Inter. Show the current step in words as well as visually. Save after each step. Save and close returns to the workspace. Resume setup restores the last answer. On phones, keep the primary action reachable with the keyboard open.

The pilot asks three things. Everything else is asked later, at the moment it changes what Daloy does.

| Screen | Ask the seller | How Daloy uses the answer |
|---|---|---|
| Business identity | "What name should customers see?" Optional website and logo. | Prefill message previews and the public form. Use initials until a logo is added. |
| Business type | One primary category and up to three related ones: online retail, food orders, beauty and wellness, professional services, Other. | Rank relevant templates. The owner can change the primary choice. |
| First workflow and payment | "What would you like Daloy to handle first?" Receipt review, bookings or order follow-up. For payment workflows: manual QR Ph transfer, GCash checkout through PayMongo, or pay later. | Create one editable draft with a sample order. If checkout setup is incomplete, the seller can still test the draft. |

Asked later:

| Question | When it is asked | Why then |
|---|---|---|
| Team size | When the seller first adds an approval or review step. | That is when "who reviews?" matters. Solo sellers get themselves as reviewer. |
| Service location | When a booking form is first published. | Online sellers never see it. A venue gets an address with an OpenStreetMap pin (Leaflet, BSD-2-Clause, no API key). A mobile seller enters a service area. Confirm what customers will see before publishing. |
| Current tools | Shown as app suggestions in the step picker, ranked by business type. | Picking an app there leads straight to connecting it, which a preference card did not. |
| Where did you find Daloy? | After the first successful sample test, skippable. | The seller has just seen it work, and the answer is not in the way of setup. |

Use the workspace's existing profile and branding. Existing owners keep their settings. Completing or resuming onboarding twice opens the same draft. Connections, publishing, messages and invitations need their own explicit actions.

## 2. Put the app and the action on every node

Every node answers which app, what action, and for whom or where. Use the connected app's logo for an integration, the seller's logo for customer-facing branding, and Daloy line icons for built-in actions. Every mark has a text fallback. The same label appears in the picker, canvas, phone list, plain-language summary and test results.

Example card: Gmail, Email customer. Under the title: To: Customer email from order. Expanding it shows the sender, subject, message, field picker and a preview with sample data. A disconnected account shows Connect Gmail.

| Node or family | Icon or app mark | Function shown to the seller |
|---|---|---|
| Form, webhook, schedule, manual start | Form, link, clock, play | Start when a form arrives, a connected system sends an event, a schedule is due, or the owner runs it. |
| Messenger, Instagram | Channel logo | Receive a customer DM or reply in that conversation within Meta's 24-hour window. |
| SMS (UniSMS) | SMS icon | Send a confirmation or reminder to a Philippine mobile number. Show the number and the per-message cost note. |
| Email | Gmail, Outlook or mail icon | Send the displayed message. Preview the resolved recipient. |
| Google Sheets, Drive | App logo | Add a row or save a file. Show the destination. |
| Slack, Teams, Telegram | App logo | Notify the selected channel or chat. Show its name. |
| Airtable, Notion, Trello | App logo | Write a record, page or card. Use the exact supported operation as the title. |
| Booking, Google Calendar | Calendar icon or logo | Reserve, move or cancel a booking, or update a calendar. Show resource and time. |
| Condition, wait | Branch or clock | Choose a labeled route or wait until a time. Show each outcome on its connector. |
| AI, approval | AI or person-check icon | Extract or classify input, or ask a named person to decide. Show output fields or decision branches. |
| Manual transfer receipt | QR Ph label and receipt icon | Collect a reference and optional receipt, match it to the order, wait for staff review. Name the reviewer. |
| PayMongo checkout, payment event | PayMongo mark, GCash label when used | Create checkout for the amount due, then handle a verified result. Show amount, order and test or live mode. |
| HTTP request, Read a public page | Globe icon | Call the endpoint or read fields from a public page. Show the domain and operation. |

Keep one catalog entry per trigger and action: plain-language description, required fields, input, output and outcomes. Generate picker entries from it. A test fails when a new node type has no label.

## 3. Guide, explain and test a new workflow

1. Connect. Show only the setup this draft needs. A form gives a shareable link. A webhook gives a copy button, the field to paste it into, a sample payload and a listening status, then confirms the sample arrived and mapped. PayMongo uses its own endpoint.
2. Write the message. Recipient, subject if any, and message together, with tappable fields such as customer name, order number and amount. Offer Taglish templates next to English and Tagalog ones. Preview the customer message and any internal notification.
3. Explain this flow. One dismissible dialog after setup, generated in English or Tagalog from the saved draft: "When a receipt arrives, Daloy asks Ana to check it. After Ana confirms, Daloy emails the customer." It can be reopened from the editor.
4. Try a sample. Fake providers only. Report configuration checks, simulated step outcomes and live connection status separately. AI can explain a failing check and suggest a repair, but the validator and test runner decide the result. Show one success and one failure, such as a missing recipient.
5. Turn on. Show which apps, recipients and payment mode will be used. The owner chooses when to activate. Editing a tested draft marks the old result as out of date.

## 4. Both payment paths

The manual path covers any QR Ph transfer. GCash, Maya and bank apps all pay to the same QR Ph codes, so the review flow is the same for each.

| Decision | Manual transfer | Automatic checkout |
|---|---|---|
| Customer action | Pay the seller's displayed QR Ph code or GCash number. Submit the order reference, transfer reference and optional receipt. | Open the order's PayMongo checkout and choose GCash when enabled for the merchant. |
| Evidence | Staff open their own wallet or bank history, match amount and reference, and record a decision. A screenshot or AI extraction leaves the order pending. | An authenticated PayMongo event must match workspace, checkout, order, currency and amount. A browser return or receipt upload leaves the order pending. |
| Who confirms | The assigned reviewer. Record reviewer and time. | Daloy, after validation. Live use needs merchant activation and an owner-run live check. |
| Exceptions | Flag duplicate references, amount mismatches and unreadable uploads. Request clarification or reject with a reason. | Repeated events give one transition and one confirmation. Mismatches go to review. Handle failed or expired checkout and later refunds. |

Staff get one Receipts to review list for manual cases and automatic exceptions: order or booking, amount due, submitted amount, reference, channel and age. Payment state and reply state stay separate. For Payment confirmed, Reply failed, retry the reply alone. If a manual transfer arrives while checkout is pending, reconcile both against the same order before sending another confirmation. Only authorized workspace staff see receipt images and decisions.

Unpaid orders get nudged. After a set number of hours, send a reminder by SMS or Messenger. After a deadline, release the booking slot or cancel the order, and tell the customer. Both steps are visible and editable in the workflow.

Pilot scenario: a seller expects a 350 peso deposit on booking D-1042. On the manual path, the receipt puts D-1042 in review. On the automatic path, a matching verified checkout event confirms it. Both update the same booking view and name the confirmation source. A deposit stays distinct from the remaining balance. Pay-later bookings proceed with an outstanding balance.

## 5. Seller daily tools

- Morning digest: one message to the owner each morning by email, Messenger or Telegram, listing receipts to review, unpaid orders and failed replies, with a link to each. Skip the message when there is nothing to do.
- Payments export: a CSV of confirmed payments by date range for bookkeeping and BIR records.
- Receipt photos are resized and compressed on the phone before upload.

## 6. Privacy (Data Privacy Act, RA 10173)

Receipt images and DMs carry customer names, numbers and account details.

- The public form and DM intake show a short notice saying what is collected and why.
- Receipt images are deleted a set time after the order closes (default 90 days, adjustable by the owner). Decisions and amounts stay in the payment history.
- The owner can export or delete one customer's data on request.
- docs/threat-model.md lists receipt images and DM content as assets.

## 7. Editing, then later integrations

Phone first. Most sellers set up on a phone, so the phone step list comes before canvas polish: add a step, reorder with up and down controls, edit in a sheet, undo.

Canvas, after that: one searchable Add step menu from the plus button, right-click or the phone sheet, with arrow keys, Enter, Escape and Shift+F10. Insert through the plus on a connection to wire the new step into that path. Drag compatible handles or use Connect to on touch and keyboard. Label branches, explain invalid connections, and undo with Ctrl+Z or Cmd+Z.

### Template ideas

From common small-business automations (patterns seen across the MIT-licensed Zie619/n8n-workflows collection), adapted to Daloy's existing steps:

- DM or form lead to Sheets, then a team alert.
- Booking confirmation, then reminders the day before and an hour before by SMS.
- Review request a day after a booking is marked done.
- Low-stock alert when a Sheets or Airtable count drops below a set number.
- Bulk-order inquiry routed to the owner for a quote.
- After-sales follow-up a week after delivery.

### Integration candidates

None of these are confirmed. For each, check that it has a public API a small seller can use, what it costs, and its terms, before scheduling it.

| Candidate | Why it matters in the Philippines |
|---|---|
| Shopee, Lazada, TikTok Shop order sync | Many sellers take most orders there and re-type them into sheets. |
| Facebook Lead Ads | Sellers run ads on Facebook and handle the leads by hand. |
| Google Business Profile | Review requests and replies for venue businesses. |
| Lalamove | Same-day delivery booking from a confirmed order. |
| Xendit | A second payment provider beside PayMongo. |
| Viber, WhatsApp | Widely used, but business messaging is paid per message, so they conflict with the free-only rule. Revisit only if a pilot merchant pays for it. |

### Reading public pages

Pilot Read a public page for supplier price alerts. Preview the extracted value, keep the last valid value on error, and cap usage per workspace.

- First version, no new service: fetch the page in the worker and extract with Mozilla Readability (Apache-2.0) or a CSS selector through cheerio (MIT). Reuse the HTTP step's private-address guard, respect robots.txt, and set a per-workspace daily cap.
- Pages that need JavaScript: Playwright's Chromium (Apache-2.0), already used for e2e, in a separate worker container with memory and time limits.
- Firecrawl: its core is AGPL-3.0, and the SDKs are MIT. Self-hosting needs Redis, PostgreSQL and a browser service. It can be an optional adapter that a deployment points at its own unmodified Firecrawl, through the MIT SDK. Daloy must keep working without it, and it is never bundled or modified.
- vercel-labs/agent-browser (Apache-2.0): a Rust command-line browser for AI agents. Use it for Daloy's own QA and walkthroughs. It is not the seller-facing runtime.
- An AI with its own browser, which logs into sites and clicks on the seller's behalf, is out of scope for the pilot. It would need per-action owner approval, a domain allowlist, no stored third-party passwords, and an answer for site terms and bot detection. Revisit when a merchant names a task that public-page reading cannot do.

## Release evidence for the owner

- Test in English, Tagalog and Taglish templates at 390px and desktop width. Verify keyboard-only setup, accessible names, tap targets, saved answers and no horizontal overflow.
- Run both payment paths with fakes: duplicate receipts, duplicate webhooks, wrong amounts, two staff reviewing at once, failed replies, refunds, unpaid-order nudges and a pay-later order. Each order shows one clear payment history.
- Produce an offline walkthrough before asking for merge or rollout approval: onboarding, expanded node settings, sample test results and both confirmations.
- Ask one seller to set up and test a workflow unaided, name who receives each message, then find the next unpaid order on their phone. Record time to first successful sample and median time from receipt submission to staff confirmation. Use the results to choose the next release.

## Changes from the owner's draft

1. Onboarding is three screens for the pilot. Team size, service location, current tools and referral moved to the moment each one matters.
2. The venue map uses OpenStreetMap and Leaflet. Google Maps needs a billing account, which breaks the free-only rule.
3. Business categories are Daloy's own five, not a salon-focused list.
4. The manual path covers any QR Ph transfer, not only GCash.
5. Added unpaid-order nudges, a morning digest, a payments CSV export, Taglish templates and on-phone receipt compression.
6. Added a privacy section for RA 10173.
7. Phase 4 starts with the phone step editor, then the canvas.
8. Phase 5 now has template ideas, integration candidates to check, and a page-reading plan with license notes for Firecrawl and agent-browser.

### Implementation references

Reuse Daloy's booking lifecycle (decision 0032), PayMongo Checkout Sessions (0045), test-run modes (0028), draft checks (0033), UniSMS (0074) and Messenger and Instagram intake (0075).
