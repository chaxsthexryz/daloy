# Integrations roadmap: verdicts and proposals

Written by DeepSeek (deepseek-flash) on 2026-11-18, at the owner's request, as input to a second opinion from Claude.
Nothing here is decided, scheduled or built. This is a proposal, not a decision record; anything that survives review belongs in `docs/decisions/NNNN-title.md`.

## Assumptions this rests on

- Self-hosted installation, Postgres only (no Redis), one owner per workspace, small offices in Manila.
- Google Sheets and Google Calendar work through a service account; Outlook through the installation's Entra app.
- Payments run through PayMongo, which is already connected.
- The AI model is hosted (DeepSeek V4.1 Flash), paid per token by the owner.

## Where the code stands today

- Step types: ai, airtable, approval, booking, calendar, condition, delay, email, http, notion, outlook, payment, sheets, slack, teams, telegram, trello.
- AI tasks: classify (2 to 20 labels), extract (1 to 20 fields), summarize, draft. Text only; input cut at 20,000 characters; reply checked against a fixed schema; one repair on a malformed reply.
- Form field types: text, email, number, textarea, datetime, resource. No file upload.
- Incoming email: plain text stored, attachments left in the mailbox, messages over 256 KiB skipped.
- Plan meters: Pilot 100, Business 500, Business Plus 2,000 AI actions per cycle; email and HTTP counts per day.

## Verdicts

| Item | Verdict | Size | Reason | Depends on |
| --- | --- | --- | --- | --- |
| Daloy table, with rows, a page, an "Add a row" step and "new row" trigger | Build now | Large | The table is the middle of every flow that does not need Google. Without the trigger it is only a place to write. | Nothing |
| Schedule watchdog: a schedule that has not fired in two cycles emails the owner | Build now | Small | The most common silent failure. A stalled schedule looks exactly like "nothing to do". | Nothing |
| Quiet hours: hold sends outside 8am to 6pm Manila, release after | Build now | Small | Prevents 2am client email, which is the first complaint a self-hosted automation gets. | Nothing |
| Weekly digest: runs, failures, money moved, what needs a person | Build now | Small | Makes the product visible without opening it. Uses counts already stored. | Nothing |
| Renewal reminders template: schedule plus table | Build now | Small | No vendor, no key, understood in five seconds. | Table |
| GitHub and deploy alert recipe | Build now | Small | A webhook recipe and a starter, no API work. Strong demo for a developer's own site. | Nothing |
| Payment received trigger for PayMongo | Build now | Medium | Money should never depend on a screenshot. The webhook secret is already held. | Nothing |
| File field on forms, plus storage | Next | Medium | No photos, receipts or attachments until this exists. | Nothing |
| Google Drive step: save received files into a folder | Next | Small | The service account covers it. | File field |
| AI vision: read a photo or a PDF | Next | Medium | The chosen provider already accepts images; only the client and storage are missing. | File field |
| Invoice PDF plus unpaid chase | Next | Medium | Small renderer, then schedule and condition. Directly useful for freelance billing. | File field for the PDF |
| WhatsApp Cloud API delivery | Next | Medium | Highest reach here, but needs a Meta app, approved templates and per conversation cost. | Nothing |
| Shopify and WooCommerce order starter | Next | Small | A webhook recipe, not an integration. | Nothing |
| Receipt photo to expense row | After the two above | Medium | The concrete demo, but it needs files and vision first. | File field, vision |
| E-signature through Dropbox Sign | Later | Medium | Real value, another vendor, another OAuth, free tier is narrow. | File field |
| Stripe payments | Later | Medium | PayMongo covers cards and GCash locally. Stripe is for clients abroad. | Payment trigger pattern |
| SMS through Semaphore or Twilio | Later | Small | Email and WhatsApp cover most people first. | Nothing |
| Google Sheets through OAuth, bring your own client | Later, on demand | Medium | The service account works with no review. OAuth helps only when a client demands their own login. | Nothing |
| AI assistant step with tools, looping | Skip for now | Large | Breaks the no-loops rule the engine is built on, cost is unbounded, the audit trail gets vague. A router step gives most of the feel for a fraction of the risk. | Nothing |
| General browsing | Skip | Large | Needs a real browser, reopens the SSRF hole the HTTP step closed, breaks weekly, costs tokens per page. | Nothing |
| GCash scraping | Never | Large | No public merchant API, needs the owner's login, breaks the terms of service, and a screenshot proves nothing. | Nothing |

## New ideas

Trust and reliability:

| Idea | Verdict | Size |
| --- | --- | --- |
| Schedule watchdog (above) | Build now | Small |
| Quiet hours (above) | Build now | Small |
| Weekly digest (above) | Build now | Small |
| Bulk retry on the dead-letter list | Next | Small |
| Cost per automation, from stored token and message counts | Next | Small |
| "Suggest a fix" after repeated failures, built on the existing explainer | Next | Small |

Adoption:

| Idea | Verdict | Size |
| --- | --- | --- |
| Approvals by Telegram or WhatsApp reply ("reply 1 to approve") | Next | Medium |
| Escalation chain: no answer in two hours, ask the next person | Next | Medium |
| Branded hosted form: logo and colour per workspace | Next | Small |
| Replay a past run with an edited payload | Next | Medium |
| Saved test fixtures per workflow | Next | Small |

Engine and security:

| Idea | Verdict | Size |
| --- | --- | --- |
| Attachments on email steps | After file field | Small |
| Duplicate detection on requests ("this looks like REQ-S7B61A") | Next | Small |
| MCP token scopes, read only against run | Later | Medium |
| Multi-step approval (manager, then finance) | Later | Medium |

## Revised plan after the owner's review (replaces the earlier sprint list)

The owner asked which of the recommendations are actually good. Roughly half are, a third depend on real strangers signing up, and eleven were cut. This list replaces the four sprints proposed earlier in this conversation.

### Build now: six small things, one story

"Daloy holds your data, keeps your paperwork and tells you when something stops."

| Item | Size | Why it earns its place |
| --- | --- | --- |
| Daloy table, new-row trigger, `.xlsx` and `.csv` export | Large | Replaces Sheets with no login, no sharing and no vendor review. Scope: typed columns, a read-only grid, export and import. No inline editing yet. |
| Schedule watchdog | Small | The failure that makes people stop trusting automation. |
| Weekly digest | Small | Built from counts already stored. Makes the product visible without opening it. |
| Brand kit: logo, colour, business name | Small | One change upgrades every form, email and PDF. Best value per hour on the list. |
| Invoice PDF, saved as a file | Medium | The output a freelancer actually needs, and the first real use of the file store. |
| Four starter templates, not eight | Small | Invoice chase, booking reminder, lead reply, renewal reminder. A catalogue is never read; four good ones are. |

Files (list, preview, download) belongs here too, because an invoice PDF that cannot be seen is half a feature. Its cost is security surface: public uploads, a separate origin for previews, size caps, retention.

### Only after real users sign up

| Item | Why it waits |
| --- | --- |
| Continue with Google and magic-link sign-in | Only matters once strangers register. A demo login is enough until then. |
| Self-serve plan page | Today's SQL-set plans are fine for people the owner knows. |
| HTML email templates | Worth it when a paying client sees the email. Plain text is honest before that. |
| WhatsApp | Needs a Meta app, approved templates and per conversation cost. Pays off at volume only. |
| Booking page with a slot picker | Large, and it competes with Calendly. Build when a client asks. |

### Considered and rejected

| Rejected | Reason |
| --- | --- |
| PWA and push notifications | A service worker plus VAPID keys, for approvals that already arrive by email and Telegram. Real work, small payoff. |
| White-label and a client portal | Premature. Nobody has asked, and both are large. |
| Signature box drawn on a form | A drawn signature is legally weak, and it overlaps e-signature, which is already deferred. |
| QR codes for form and booking links | Twenty lines of novelty, not a feature. |
| `.pptx` export | The largest of the three formats for the least use. |
| Agent step that loops with tools | Breaks retries, idempotency, leases and the audit trail. A router step is the safe version. |
| General browsing | Needs a real browser, reopens the SSRF hole, breaks weekly, costs tokens per page. |
| GCash scraping | No merchant API, the owner's login, breaks the terms, and a screenshot proves nothing. PayMongo webhook instead. |
| Stripe, SMS, e-signature, multi-step approval, MCP token scopes | All reasonable, all "when a client asks". |
| Comments on a run | The approval decision already records who, when and why. |
| Eight-template gallery | Four starters cover the same ground without a catalogue to maintain. |

### One correction to an earlier decision

The auto-deploy built on 2026-11-18 (a draft with no lint warnings is created and published in one step, decision 0048) is the one change in this work that weakens the product: a stranger's install can have a live automation nobody read. It should become "created and ready, one press to turn it on" before this is published. The watchdog is partial compensation, not a fix.

## More ideas, thought through (second pass)

Only four of these ten are worth defending. One of the earlier proposals is withdrawn.

| Idea | What it does | Size | Depends on | Risk |
| --- | --- | --- | --- | --- |
| Auto-pause a failing flow | Three runs fail in a row, the automation pauses itself and emails the owner | Small | Nothing | None worth naming |
| Send brake per flow | A daily cap on sends from one automation ("never more than 50 emails") | Small | Nothing | A refused send mid-run needs a clear message |
| Summary for the owner's client (PDF) | One page of what the automation did this month, in plain words | Small to medium | PDF renderer | Must use only the closed-set facts the explainer already uses |
| Spreadsheet in, automations out | Import an `.xlsx`; the AI reads headers and three sample rows and proposes flows | Medium to large | Table, import | Sample rows reach the model, so it has to be opt-in and stated |
| Retention per table | Delete rows older than a set age, archive to CSV first | Small | Table | None; it is also the answer to "where does my customer data go" |
| Fixes as a diff | The AI returns a change to the definition, shown as a diff to accept | Medium | Nothing | A wrong patch edits steps nobody asked about |
| Change impact before publishing | "This version changes the recipient of three future reminders" | Medium | Versions and runs | Approximate advice can mislead |
| Handoff pack | The automation as JSON plus a one-page how-it-works, for the client | Small | Nothing | Low |
| Status page | `/status`: database, worker, last schedule fire | Tiny | Nothing | None |
| Screenshot to recipe | Paste a picture of a form, get a proposed flow | Medium | Vision, files | Weak accuracy, strong demo |

Defended: auto-pause, send brake, client summary, spreadsheet in. Cut: fixes as diff, change impact, handoff pack for now, status page until launch week, screenshot to recipe until vision exists.

Withdrawn: the router step. Classify already picks one of up to 20 labels and a condition step branches on it, so "the model chooses the next action" is what the product does today. A router would be sugar with another prompt to maintain.

## Questions for the second opinion

1. Is the table worth a large phase, or should "add a row" stay on Google Sheets and Airtable and skip storage the product has to own?
2. Is the schedule watchdog better as an email, a console badge, or both?
3. Quiet hours: is a hold and release in the worker the right place, or should it be a delay step the template includes?
4. Should the payment trigger be PayMongo only, or generic (a signed webhook the owner configures)?
5. Files: local disk in compose with an optional S3/R2 setting, or object storage only? What is the size cap per file and per workspace?
6. Vision: one new task type ("read"), or an optional image input on the existing four tasks?
7. Is a router step (AI picks one of N named next actions) worth adding now, given the agent step is skipped?
8. Does WhatsApp justify its per conversation cost against email for this audience, or is Telegram the honest answer until a client asks?
9. Anything here that should be cut from the backlog entirely rather than deferred?
10. Should the table export `.xlsx` at all, or is `.csv` plus a documented column order enough, given that Sheets imports CSV?
11. Do the table's columns get types and required flags (as proposed), or stay free text?
12. Is a read-only grid acceptable at launch, with inline cell editing deferred until column types and an audit exist?
13. `exceljs` against `pdfkit`: is pulling two libraries better than generating `.xlsx` by hand for a fixed column set?
14. Is the six-item short list right, or is one of the six too large to sit beside five small ones?
15. Files: is the security surface worth it at this stage, or should the invoice PDF wait until Files exists as its own phase?
16. Is four starter templates the right number, and are those four the right four (invoice chase, booking reminder, lead reply, renewal reminder)?
17. Should the auto-deploy of a clean draft be reverted to "created and ready, one press to turn on" before the Oracle launch?
18. Anything in the rejected table that should come back, and why?
19. Is three failures in a row the right point to pause a flow, or should it be a ratio over a longer window?
20. Should the send brake be per automation (as proposed) or per workspace?
21. Can the client summary safely reuse the explainer's closed-set facts, or does it need its own narrower set?
22. Is import-then-suggest worth its size before there are users, given that it depends on the table and the importer?
23. Anything in this second pass that belongs in the rejected table instead?
