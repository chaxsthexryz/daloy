# Daloy security review, 19 November 2026

**Release decision.** Hold public sign-up and automatic fulfilment of paid orders. A buyer can set the expected price, a sandbox payment can start real work, and a public submission can cross a change to a protected workflow. Fix those three first. Before real accounts, also close the shared-resource limits and the gaps in webhook verification and history redaction below.

Reviewed local `main` at `183329c8ab65c3869f4f246ad9663599aa369a5f`. Scope covers N6, N9, N10a/b, N12 through N15, and T1. It also follows changes to those paths already on this revision, including forms with files. N11a and N11b are still separate work in progress. This is a source review for N11c. Repeat the affected checks on the eventual release commit.

I traced controllers through validation, database queries, the worker, provider calls and existing test assertions. The previous review handoff is [the security regression retest](retest-security-fec03cc.md). The scenarios below describe consequences of the source as written. No application, test suite, live provider, deployed endpoint or production data was exercised. High severity means a public or less-trusted action can cross an authorization or payment boundary with material consequences. Each finding states any required configuration or timing.

## High severity

**H1. A buyer sets the price that counts as paid (T1).** An office using the public order starter for fixed-price goods can receive a genuine paid notification for an expensive item after a buyer pays only the amount they entered. PayMongo's signature and amount check both succeed because the original expected amount also came from the buyer. The starter records rows and sends links. Loss occurs if staff or another automation fulfils based on that record. The pending row uses pesos and the paid starter writes the raw centavo amount, which makes a manual comparison misleading. `packages/engine/src/templates.ts:226`, `packages/engine/src/templates.ts:232`, `packages/engine/src/templates.ts:251`, `packages/db/src/paymongo.ts:96`, `apps/api/src/public.ts:158`.

Fix by deriving the payable amount from an owner-maintained price or an approved quote. Tie the checkout to an immutable order reference and use one labelled currency unit in both rows. Verify that changing a public field cannot change the price of a known item.

**H2. Test payments can start live actions (N12).** An office can test a checkout while a published payment listener still sends real messages or updates a real order sheet. The webhook verifies the event against the connection's current mode, then drops the mode and starts an ordinary run. It also drops the originating run's test flag. A genuine sandbox success is enough. No forged signature or real payment is needed. `apps/api/src/public.ts:128`, `apps/api/src/public.ts:158`, `apps/api/src/public.ts:163`, `packages/db/src/schema.ts:186`, `apps/worker/src/advance.ts:152`.

Fix by binding the stored payment to the verified event mode and carrying mode and source-run test status into the listener. Default sandbox follow-ups to mocked actions. Give a deliberate integration test a separate destination. Verify both a sandbox checkout and a builder live-call test against a configured production listener. Neither should create a production fulfilment record.

**H3. A public submission can run a newly protected version (N9 and webhook intake).** During republishing, the API reads the public trigger in one query and the latest published version in a later query. A visitor whose submission overlaps an owner's switch from a public form to a staff-only manual workflow can have their input run against the new version. A generic webhook can likewise authorize against the old signing configuration and enqueue the new definition. The visitor needs the old public entry point and the requests must overlap the publish. `apps/api/src/public.ts:244`, `apps/api/src/public.ts:245`, `apps/api/src/public.ts:219`, `apps/api/src/public.ts:73`, `apps/api/src/public.ts:81`, `apps/api/src/public.ts:90`, `apps/api/src/workflows.ts:286`.

Fix by resolving the trigger, its security settings, fields and exact published version from one database snapshot. Enqueue only that version. Apply the same invariant to payment listener selection at `apps/api/src/public.ts:161`. Verify by pausing a submission between reads while changing the trigger. The old authorized version may run or the request may be refused.

## Medium severity

### M1. A blank signing-secret name allows unsigned booking changes

An owner can save an imported or API-created booking changer that the schema classifies as signed. The receiver skips verification for an empty name. Someone holding its URL and a relevant booking reference can change bookings and their calendar events. The normal editor usually omits an empty field. `packages/engine/src/definition.ts:197`, `packages/engine/src/definition.ts:319`, `apps/api/src/public.ts:78`, `apps/api/src/workflows.ts:350`

Require a nonblank valid secret name and a usable workspace secret before publishing a protected trigger. Fail closed at intake for existing definitions too. Cover missing, blank, removed and valid secrets.

### M2. Old generic webhook deliveries can repeat financial work

The generic HMAC authenticates only the body. Its caller-supplied deduplication header is outside the signature. The invoice starter sets neither a signer nor a business event key. A party with a captured valid delivery can repeat it on a signed workflow without a stable event key. On the stock invoice starter a sender with the bearer URL can originate invoices, and an ordinary delivery retry can create another checkout and email. Operators can read the full trigger row, including the URL. `apps/api/src/public.ts:77`, `apps/api/src/public.ts:170`, `apps/api/src/http.ts:126`, `packages/engine/src/templates.ts:261`, `apps/api/src/workflows.ts:107`

Require verified intake for invoice issuance. Bind freshness and event identity to the authenticated message, scope deduplication to the workflow, and use an immutable invoice issuance ID. Show bearer URLs only to roles allowed to manage intake and support rotation. Verify that a legitimate retry produces one invoice and one link.

### M3. One workspace can suppress another's payment notification

Event IDs are unique across the entire installation. If one merchant delivers the same event to two Daloy workspaces, the workspace with no matching order can record it first. The workspace owning the order then returns “duplicate” and leaves it pending. Each delivery can have a valid signature. `packages/db/src/schema.ts:638`, `packages/db/src/paymongo.ts:114`, `apps/api/src/public.ts:129`, `apps/api/src/public.ts:147`

Key receipt and lookup by workspace, mode and provider event ID. Verify that the same event delivered to two workspaces can settle the correct order whatever the arrival order.

### M4. An early refund can disappear

A refund delivered before its paid notification has no matching paid row. The handler still acknowledges and records the event, so a later paid notification can leave a refunded order marked paid. The same gap applies to a paid callback received before Daloy stores its checkout session. `packages/db/src/paymongo.ts:108`, `apps/api/src/public.ts:137`, `apps/api/src/public.ts:141`, `apps/api/src/public.ts:147`, `apps/worker/src/steps/paymongo.ts:32`

Durably retain an unmatched supported event for reconciliation before acknowledging it. Verify refund-first, checkout-row-late and duplicate delivery. Reserve immediate acknowledgement without reconciliation for intentionally ignored event types.

### M5. Turning off live PayMongo leaves saved live credentials usable

The runbook tells the operator to turn the flag off after a check. A later public order can still create a real checkout with the previously saved live key. Creating a checkout does not itself charge the buyer. `docs/live-paymongo-check.md:33`, `apps/api/src/connections.ts:256`, `apps/worker/src/steps/paymongo.ts:27`

Check the effective live policy immediately before creating a session. Keep a defined way to settle existing live payments after outbound creation is disabled. Verify the flag change with a previously saved live credential.

### M6. Public sign-up grants unbounded background work

Registration creates an owner with no plan. That state bypasses the live automation and schedule limits and leaves HTTP usage uncapped. An unapproved owner can leave scheduled work consuming shared worker and database capacity. Uploads have a separate cap and the operator's paid AI key requires a plan. Unlimited private installations were an explicit N6 decision. `apps/api/src/auth.ts:83`, `packages/db/src/schema.ts:21`, `apps/api/src/workflows.ts:209`, `apps/worker/src/worker.ts:34`, `packages/db/src/usage.ts:16`, `packages/db/src/ai-settings.ts:66`

Give public sign-ups finite limits or preview-only access until approved. Keep unlimited operation an explicit installation choice. Test a fresh account from registration through publication and worker dispatch.

### M7. The AI settings test can spend after the monthly limit

A plan owner whose workspace uses the operator's shared paid key can repeatedly run the sample after spending the last AI action. The route has a ten-per-minute limit but never reserves a monthly action. The sample text is fixed. This is a documented N6 exemption with a real cost once outsiders have accounts. `apps/api/src/settings.ts:145`, `apps/api/src/settings.ts:150`, `packages/db/src/ai-settings.ts:66`, `docs/decisions/0038-quotas-and-metering.md:50`

Charge a shared-key generation before dispatch or verify the connection without generating text. Assert zero provider calls at exhaustion. Keep a separate operator spend ceiling for paid attempts, including manual retries, while preserving once-per-step customer billing.

### M8. An approval email undercounts recipients

A link-holder approval accepts a recipient list. With one recipient left on the plan, an owner can send to up to ten addresses while consuming one unit. The separately enforced shared-relay limit can still refuse the send. Named approvals resolve to one member. `apps/worker/src/steps/index.ts:225`, `apps/worker/src/steps/index.ts:240`, `packages/db/src/mail.ts:130`, `packages/db/src/mail.ts:147`

Resolve and validate the final recipient list once, reserve its full length, then create the link and send to that list. Test a two-recipient approval with one recipient left.

### M9. Some history views return text the run page hides

An operator viewing office requests, or a bearer-token holder reading run status, can receive a secret present in a legacy run error. Both paths return stored error text directly. The normal run detail redacts current and retired values, and the repository already has a regression fixture for historical secret-bearing rows. Fresh worker errors usually receive write-time redaction. `apps/api/src/workflows.ts:140`, `apps/api/src/mcp.ts:137`, `apps/api/src/runs.ts:151`, `apps/api/src/secrets-history.test.ts:51`

Share the read-time redactor across request lists, run status and delivery summaries, or return only fixed error codes where text adds little. Extend the historical-row fixture to each reader after rotation. Calendar can also persist provider-supplied error prose, so map it to safe messages before storage. See `packages/db/src/providers.ts:274` and `packages/db/src/deliveries.ts:329`.

### M10. A public receipt can carry a stranger's message under the office's identity

The client-request starter copies the full free-text request into an email to the address supplied on the same form. A stranger can send a convincing instruction or link to an unrelated recipient from the business inbox. Plain-text sending and email syntax checks still allow this. `packages/engine/src/templates.ts:154`, `packages/engine/src/templates.ts:164`, `apps/api/src/public.ts:196`

Use a fixed acknowledgement and an opaque reference for unverified recipients. Keep submitted text in the staff record. Test that arbitrary text and links from the form never appear in the outgoing acknowledgement.

### M11. Calendar changes can disclose an existing guest's booking to a new audience

Each queued delivery remembers its destination, but the booking's calendar-event record does not. After a switch from a private calendar to a shared one, rescheduling an old booking can copy guest details to the new calendar. Cancelling can report success there while leaving the old event visible. `packages/db/src/calendar.ts:14`, `packages/db/src/calendar.ts:36`, `packages/db/src/calendar.ts:51`, `packages/db/src/providers.ts:327`

Bind the account and calendar ID to the event for its lifetime. If the original destination becomes inaccessible, ask the owner to reconnect or explicitly move it. Test changing calendars between creation and cancellation.

### M12. Overlapping calendar writes can undo a cancellation

A delivery reads booking state before calling Google. An older active update can finish after a later cancellation because calendar sends skip the booking lock and several deliveries run concurrently. The update can restore a confirmed event with the guest's details. `packages/db/src/deliveries.ts:134`, `packages/db/src/deliveries.ts:176`, `packages/db/src/deliveries.ts:258`, `packages/db/src/providers.ts:339`

Order sends per booking and reconcile the latest version after an uncertain or delayed write. In the fake calendar, delay an old update past a cancellation and verify the remote event ends cancelled.

### M13. Slow draft mailboxes can delay other offices' mail

A workspace can create drafts and request mailbox checks without publishing them. One poller per worker selects one globally due mailbox, and a transient failure keeps it eligible. Multiple slow sources from one workspace can delay another office's incoming requests. The per-connection deadline limits each turn. `apps/api/src/email-source.ts:37`, `apps/worker/src/email-in.ts:59`, `apps/worker/src/email-in.ts:69`, `apps/worker/src/email-in.ts:197`, `apps/worker/src/imap.ts:122`, `apps/worker/src/worker.ts:134`

Cap pending checks per workspace, back off failing sources and give live workspaces a fair share of polling. Verify a healthy office progresses while another has slow draft connections.

### M14. One origin can submit a tracked request in a member's name on another origin of the same site

Embedded submissions intentionally ignore the session. The standalone form trusts the session alone and accepts an ordinary form POST. If an untrusted sibling origin shares the same site and scheme, a signed-in visitor can be falsely recorded as the requester. An approval still requires its own decision. `apps/api/src/public.ts:226`, `apps/api/src/public.ts:228`, `apps/api/src/auth.ts:169`, `apps/api/src/app.ts:58`

Require an exact trusted origin or a session-bound anti-forgery token before attributing a request. Treat other public submissions as anonymous. Cover same-site sibling, external embed and legitimate same-origin submission.

### M15. Repeating one file submission can exhaust the office's upload allowance

On a tracked form, the workspace pays the upload count before the submission key is checked for an existing request. A visitor or browser retry can consume multiple units for the same request and stored file, eventually refusing genuine uploads. `apps/api/src/public.ts:214`, `apps/api/src/public.ts:228`, `apps/api/src/public.ts:291`, `packages/db/src/usage.ts:77`

Make the upload reservation part of the same atomic decision as accepting the first submission and saving its files. Verify concurrent duplicates return the original reference, store one file, and consume one unit.

### M16. Airtable can silently redirect queued records when a table name is reused

A connection accepts a name or an ID and pins the supplied string. A collaborator with table-management rights can rename the original and give a replacement the old name. Pending customer records then go to the replacement if the saved token can write there. An installation already using immutable table IDs avoids this condition. `apps/api/src/connections.ts:84`, `packages/db/src/providers.ts:514`, `packages/db/src/providers.ts:520`, `packages/db/src/deliveries.ts:219`

Resolve or require an immutable table ID during connection. Reconfirm old name-based destinations before delivering queued records. Cover a rename and a replacement with the former name.

### M17. Unverified guests can reserve real appointment slots

A visitor can reserve an available hour on an office resource using a name and unverified email address. The Lead to Booking starter creates the reservation before sending the confirmation. A visitor reserving several slots can displace real customers even within the intake rate limit. This applies when the office publishes the starter as an open booking form. `packages/engine/src/templates.ts:182`, `packages/engine/src/templates.ts:188`, `packages/engine/src/templates.ts:193`, `apps/api/src/public.ts:196`.

For public bookings, use a short-lived hold until the guest confirms or staff approve. Limit outstanding holds per resource and how far ahead a visitor can reserve. Verify that an unconfirmed request expires and the next guest can book the slot.

## Route and data checks

| Surface | Access and data traced at the reviewed commit |
| --- | --- |
| Usage, templates and payment status | `GET /usage` and `GET /templates` require owner or operator. Usage is scoped by session workspace. T1 adds definitions and a worker step. The status lookup uses the worker's run ID and a definition-validated payment-link step ID. A form visitor cannot request another run's payment status through this step. `apps/api/src/usage.ts:8`, `apps/api/src/workflows.ts:368`, `packages/engine/src/definition.ts:315`, `apps/worker/src/steps/index.ts:289`. |
| Email sources | Read, save, check and disconnect under `/workflows/:id/email-source` all require the owner and verify workflow ownership. The password is authenticated-encrypted for the workspace and workflow, omitted from status and cleared on disconnect. IMAP checks all resolved addresses, pins the selected IP, and verifies TLS against the original host on port 993. The worker bounds messages, excludes attachment bytes, deduplicates by mailbox generation and UID, and commits the checkpoint with the run. Sender and Reply-To remain assertions from incoming mail. `apps/api/src/email-source.ts:17`, `apps/api/src/email-source.ts:58`, `packages/db/src/email-sources.ts:61`, `apps/worker/src/imap.ts:51`, `apps/worker/src/imap.ts:79`, `apps/worker/src/email-in.ts:157`. |
| Public forms and embeds | Both GET and POST are public by design. The page exposes business branding, declared fields, and active resource IDs and names for this workspace when a resource is requested. A tracked submission returns its own reference. Embed mode allows framing and drops requester attribution. Submitted file references are created server-side. Download requires an owner or operator and a matching workspace, run and file, including for Drive deliveries. `apps/api/src/app.ts:60`, `apps/api/src/resources.ts:15`, `apps/api/src/public.ts:188`, `apps/api/src/public.ts:226`, `apps/api/src/public.ts:256`, `apps/api/src/runs.ts:127`, `packages/db/src/deliveries.ts:147`. |
| Failure explanations and Ask | Owners and operators can read fixed explanations and Ask answers. Only owners can request model wording. Ask is off unless enabled. Queries constrain both the run or reference and the workspace. Rewording sends fixed text, structured failure facts and language, plus a fixed question and step timeline for Ask. Form text, raw errors, references, credentials and file bytes are excluded from these prompts. The response is length-limited plain text. A separate **workflow AI step** can intentionally send the configured input, including customer mail or form text, to the owner's selected provider. Build with AI also sends the owner's conversation and supplied draft. `apps/api/src/runs.ts:46`, `apps/api/src/runs.ts:99`, `apps/api/src/runs.ts:168`, `apps/api/src/runs.ts:185`, `apps/api/src/runs.ts:209`, `apps/api/src/explain.ts:43`, `apps/api/src/explain.ts:86`, `packages/engine/src/ai.ts:78`, `apps/api/src/ai-chat.ts:43`. |
| PayMongo | The public callback uses the path to select a workspace and then verifies the mode-specific HMAC over timestamp and exact body bytes with constant-time comparison. The acceptance window is 72 hours past and five minutes future. A known pending session changes to paid only on matching stored amount and currency. Follow-ups are keyed per payment and status within each workflow. These controls are independent of H1, H2 and M2 through M5. `packages/db/src/paymongo.ts:26`, `apps/api/src/public.ts:116`, `packages/db/src/paymongo.ts:96`, `apps/api/src/public.ts:163`. |
| Provider settings and delivery recovery | All six providers' connect/replace and test routes inherit the owner guard, as do connection status and disconnect. Each uses the session workspace. The six connect/test pairs start at `apps/api/src/connections.ts:181` (Calendar), `:234` (Telegram), `:252` (PayMongo), `:277` (Airtable), `:295` (Notion) and `:313` (Trello). The shared guards are at `apps/api/src/connections.ts:118` and `apps/api/src/connections.ts:486`. Delivery status, retry and manual confirmation require owner or operator and scope the delivery by workspace. Credentials are encrypted with workspace and provider as associated data. Status exposes account, destination and last error. `packages/db/src/connections.ts:12`, `packages/db/src/connections.ts:28`, `packages/db/src/deliveries.ts:294`, `packages/db/src/deliveries.ts:335`. |
| Outbound addresses and template injection | Named provider clients build requests from fixed or installation-configured origins and refuse redirects. Google credentials contribute only the email and signing key. Destination IDs become URL components or JSON values. Telegram sends plain text and avoids echoing its token-bearing request URL. Trello includes credentials in the query, so outbound infrastructure must also omit URLs from logs. Generic HTTP checks IPs at connection time and each redirect. Model hosts are configured, but the LLM client's fetch calls still accept redirects. Disable model redirects or enforce the same origin on every hop before treating the configured host as a hard privacy boundary. No user-selected LLM base URL was found. `packages/db/src/providers.ts:48`, `packages/db/src/providers.ts:76`, `packages/db/src/providers.ts:485`, `packages/db/src/providers.ts:557`, `apps/worker/src/steps/http.ts:24`, `apps/worker/src/steps/http.ts:96`, `packages/llm-ts/src/index.ts:122`. Form labels are escaped, expressions resolve once using own properties, only HTTP steps receive secret substitutions, Sheets writes string cells, and Notion sends structured text. These controls prevent interpreting submitted template syntax as code but leave the business-content abuse in M10. `apps/api/src/public.ts:344`, `packages/engine/src/expressions.ts:30`, `packages/engine/src/expressions.ts:49`, `apps/worker/src/steps/index.ts:319`, `packages/db/src/providers.ts:226`, `packages/db/src/providers.ts:548`. |

## Before release

1. Give the three high findings regression coverage with the existing fake providers and disposable database. Add two-workspace tests wherever an ID, account, counter or destination is shared. Run the owner, operator, approver, requester and signed-out checks against every new route. The existing matrix at `apps/api/src/members.test.ts:183` enumerates routes manually. Focused assertions already exist at `apps/api/src/ask-api.test.ts:198`, `apps/api/src/explain-api.test.ts:141` and `apps/api/src/paymongo.test.ts:202`.
2. On the deployed topology, verify trusted proxy settings, cookie flags, separation from untrusted sibling sites, and URL redaction in proxy and outbound logs. Set an aggregate upload budget before the multipart parser. It buffers files even before the form lookup, and per-file and per-IP limits alone do not bound total concurrent memory. `apps/api/src/app.ts:56`, `apps/api/src/public.ts:198`, `packages/engine/src/file-type.ts:4`.
3. Have the owner verify signed PayMongo **test** deliveries, event retry timestamps and refund reconciliation before enabling real orders. The existing guide records that live behaviour remains unverified. Repeat this review on the exact release revision with N11a and N11b included. [PayMongo checks](live-paymongo-check.md) · [N11 release scope](../PROJECT.md)

## Integration priorities

**Uptime Kuma first, for operations.** Run the monitor independently of the Daloy host. Have it watch a worker heartbeat and notify the operator through the existing Telegram channel. This complements the in-app schedule watchdog when the worker or the whole host is down. Send only the service name and last successful check. [Uptime Kuma](https://github.com/louislam/uptime-kuma)

**WooCommerce next if a pilot sells online.** The store-order starter already exists at `packages/engine/src/templates.ts:387`. Improve its intake by verifying WooCommerce's native webhook signature, mapping the store's order ID and total, and deduplicating deliveries. This gives H1 an authoritative price source for shops. Keep a catalogue or staff-approved quote for offices that do not use WooCommerce. [WooCommerce webhook reference](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/)
