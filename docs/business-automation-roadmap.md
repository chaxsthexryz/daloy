# kymavo business automation roadmap

This is proposed work after phases 0 through 9. The first release should let one office manager set up an automation and share a form with colleagues. Employees who only submit a request should be able to use the form without learning the editor. Start the portfolio demo with **Track an office request**. Use **Reply to a website inquiry** to demonstrate a client connecting their own mailbox.

## Start here for the implementation handoff

Open the portfolio folder containing `AGENTS.md` and `daloy/`. Read [kymavo's project specification](../PROJECT.md) first, then the portfolio working rules in `AGENTS.md`. Work inside the existing `daloy/` project. Use the files on disk, including pending edits and migrations.

When the owner says “go for phases 1 through 5 in one run”, that is their go for each of those five phases. Use the [implementation sequence](#implementation-sequence) and [release acceptance checks](#release-scope-and-acceptance-checks). Plan, implement, test and commit each phase in order. Leave phase 6 for the owner's pilot choice. If an external account is unavailable, record the outstanding live check and continue the work that can run locally. Deliver the tested project and the walkthrough described at the end of this file.

## Where beginners get stuck today

| What someone sees today | Proposed change |
| --- | --- |
| The home screen asks for a name, defaults to a blank workflow, and places API tokens and AI settings in the header. | Ask “What do you want to automate?” Offer a working example with a suggested name. Put API tokens under advanced settings and show model setup when someone chooses an AI task. |
| Creating a workflow opens a diagram with step IDs, branches and expressions. | Open a short setup form for supported templates. Show the sequence as ordinary sentences. Keep **Open advanced editor** available from the automation detail page. |
| Testing asks for sample trigger data in JSON. A checkbox changes whether calls go to real services. | Give the user a filled-in sample form and show what each person would receive. Give the separate live connection test a button that names the recipient. |
| Publishing exposes a form link inside the editor. Run history sits inside each workflow. | After activation, put **Copy form link** beside **View activity**. Show recent outcomes on the returning user's home screen. |

The [workflow list](../apps/web/src/App.tsx), [editor](../apps/web/src/Editor.tsx), and [current screenshots](../README.md#screenshots) show the starting point. Existing workflows must still open with their saved steps, live version and history intact.

## A first visit, from sign-in to a real result

Example: Ana manages a small office. Staff message her about broken equipment. She wants requests in one place and a receipt employees can refer to. She has never used n8n.

| Screen | What Ana does | What kymavo shows next |
| --- | --- | --- |
| Home | Selects **Track an office request**. | “Staff fill in a form. Each request gets a reference. Your office receives a notification.” Actions are **Try an example** and **Set up for my office**. |
| Try an example | Submits the sample “The printer on floor 2 is jammed.” | **Preview only**. A sample reference, the row that would be recorded, the notification text and the receipt. Nothing is sent or written to an external app. |
| Set up | Accepts the name “Office requests”, selects the fields staff fill in, and chooses where requests and alerts go. | Offer the local request list first. Show **Choose a spreadsheet** or **Choose a channel** when those connections are available. Ask for a connection at the point it is needed. |
| Review | Reads “Save each request to Office requests. Notify the office manager. Send the employee a receipt.” | Show the actual destinations, sender and example message. **Edit** returns to that answer. **Save and finish later** retains the draft. |
| Turn on | Selects **Turn on**. | **Accepting requests**, with **Copy form link** and **Open form**. A local demo labels a localhost link as usable on this computer. A client needs a reachable installation to share the form with staff. |
| Check the result | Submits one request through the live form, then opens **Activity**. | The employee gets a reference. Ana sees that reference, when the request arrived, where it was recorded and whether the notification was sent. A failed notification leaves the recorded request visible. |

### Returning users and navigation

- **Home** shows active automations, saved drafts and items needing attention. A fresh account offers **Try an example**. A returning user sees **Continue setup** or the last request they received.
- **Automations** lists each business task, its status, and its last result. Open one to edit settings, copy its form link, pause new submissions, view its activity, or use the advanced editor. Explain what pausing does to work already in progress.
- **Activity** answers “What happened to my request?” Search by reference and filter by automation, date, or outcome. Separate previews from live submissions. Show a plain-language outcome first, with technical details available on demand.
- **Connections** shows which account, sheet, or channel each automation uses, when it was last tested, and which tasks are affected by a disconnection. Put the business profile and developer settings under account settings.

Use **When someone submits this form**, **Send a message**, **Try with sample details**, and **Turn on** in guided setup. For variable fields, let the owner pick **Employee email from the form** from a list. Pre-fill a useful name and let them change it later. On small screens the entire journey should work as a single column. Every step needs a keyboard path, visible focus, labelled errors, and status text that makes sense without color.

## Client email and website setup

The implementer can fill in the business name, website, inquiry inbox and reply address in the client's workspace. The client enters their own sending credential. In today's one-user workspace, do the setup together or let the owner complete it. Separate staff logins and delegated setup belong to the office roles phase below.

1. Offer **Connect Gmail**. Ask for the sender address and a Google app password. Link directly to Google's instructions and explain where 2-Step Verification is required. If the account does not offer app passwords, let the client save the draft and show the reason where available. [Google account help](https://support.google.com/accounts/answer/185833)
2. **Send a test email to me** sends one message to the owner's verified address and displays the sender and reply address. Distinguish acceptance by the mail provider from the owner confirming it reached their inbox. Provide **Replace password**, **Reconnect**, and **Disconnect**. Keep the local Mailpit demo usable without an external account.
3. Use the client's inbox in the inquiry template, replacing example billing and support recipients. Make one general inbox sufficient. Offer separate destinations when the owner wants routing. A simple acknowledgement can work without AI.
4. Offer **Copy inquiry form link** after activation. Show the owner how to set their website's contact button to that link. Connecting an existing website form requires a supported integration or a developer to forward submissions. Saving a website URL only adds business information.
5. On a broken connection show, for example, “Request saved. Gmail could not send the receipt. Reconnect Gmail.” Preserve the request and retry only the failed delivery when safe. Encrypt credentials per owner, keep them out of definitions, logs, previews and AI prompts, and never fall back to another customer's account.

## Connections in order of delivery

Each connection should expose a business action, a destination picker, a sample result and a way to disconnect. Show any administrator requirement before the user leaves kymavo. Ask only for permissions needed by the chosen action. Email sending and incoming mailbox monitoring are separate capabilities.

| Priority | Connection and first action | Setup and local path |
| --- | --- | --- |
| First | **Local request list and Mailpit**. Record a request and inspect its receipt. | Use the existing database and demo inbox. This is the full offline portfolio walkthrough after installation. |
| First | **Gmail**. Send a receipt or reply using the client's address. | Use the owner setup above. The existing installation-wide mail configuration needs an explicit migration path for existing senders. |
| Next | **Google Sheets**. Add one row per request, including its reference. **Slack**. Post a summary and request reference to a chosen channel. | Let the owner pick the sheet and channel and test each independently. Use provider authorization and a workspace-approved Slack installation. Within the local demo, preview the row and message. [Sheets append](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append) and [Slack channel messages](https://api.slack.com/messaging/webhooks) |
| Next for Microsoft offices | **Outlook**. Send from the authorized mailbox. **Teams**. Post a notification to a selected channel. | Use Microsoft account consent for Outlook and a supported Teams Workflows connection for channel posts. Organization policy may require an administrator. A channel post does not authenticate an approval. [Outlook permissions](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0), [organization consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent), and [Teams notifications](https://support.microsoft.com/en-us/workflows/send-messages-in-teams-using-incoming-webhooks) |
| Driven by the first client | **Asana** creates an assigned task. **Jira** opens an IT ticket. **HubSpot** starts onboarding when a deal is won. **Google Calendar or Outlook Calendar** records approved dates. | Pick the one needed by a real pilot. For app events, verify the source and ignore repeated deliveries. Confirm permissions, account eligibility and quotas before promising support. [Asana task API](https://developers.asana.com/reference/createtask) |

kymavo and its demo must run locally with free, open-source dependencies and no paid API or credit card. Treat hosted business tools as optional connections to accounts a client already has. Use local fixtures for connector tests. Report a live compatibility check only when someone has actually run it.

## Templates worth building

| Task | How it starts and what it does | Dependency or decision |
| --- | --- | --- |
| Office or maintenance request | Staff submit an issue. Record it, return a reference, and notify facilities based on location or urgency. | First demo. One local destination is enough to prove the whole flow. |
| Website inquiry | A visitor submits the form. Acknowledge it and send the inquiry to the right inbox. | Adapt the existing template. Optional AI can classify inquiries once real examples have been evaluated. |
| Client onboarding | The owner records a new client and service. Email a service-specific checklist. A second form alerts the owner when the client sends the requested information. | Start manually. A later HubSpot connection can start the same checklist after a sale. |
| Quote follow-up | A salesperson records a quote. After a delay, ask the salesperson whether to send the prepared follow-up. | Give them a **Skip** path for accepted, declined, or withdrawn quotes. |
| Invoice or missed booking | The existing templates follow up on an unpaid invoice or reported no-show. | Replace demo billing endpoints and supply booking events. Recheck status near sending where the source supports it. |
| Post-service feedback | Staff mark a job complete. Send a short feedback form after a delay. Alert the owner when the customer requests contact. | Start with a staff form. Add the booking-system event if a client needs it. |
| Creative request or IT ticket | A brief or equipment request creates an assigned task with a due date. Send its tracking link to the requester. | Add Asana for agency work or Jira for an IT pilot. |
| Purchase request | An employee requests an item. A named manager decides. Route approved requests to purchasing and record the decision. | Requires authenticated approvers for real spending decisions. Start with tracking the request. |
| Time off or remote work | An employee requests dates. Notify them of the manager's decision and add approved dates to the team calendar. | Requires restricted access to employee records, a named approver and a calendar connection. Keep private reasons out of shared calendars. |

These examples have precedents. Talksure routed purchasing approvals through Teams. Employment Hero used Slack for creative intake alongside Asana. TUP automated calendar-related HR work. Checkwriters used a sale to start onboarding. Delivery Hero tied account recovery to manager approval. The kymavo templates above are proposals. [Talksure](https://www.microsoft.com/en/customers/story/19771-talksure-appsource), [Employment Hero](https://slack.com/customer-stories/employment-hero-drives-productivity-workflows), [TUP](https://n8n.io/case-studies/tup/), [Checkwriters](https://www.hubspot.com/case-studies/checkwriters), and [Delivery Hero](https://n8n.io/case-studies/delivery-hero/)

## Implementation sequence

Each item below is a proposed phase. Before starting one, name the exact files, migrations, risks and open questions in its short plan. Follow the owner's stated approval scope for the handoff. Write tests first for state changes, permissions, input validation and retry behavior. Keep the existing phase checklist as the record of shipped work.

| Phase | Files and data likely to change | Acceptance check |
| --- | --- | --- |
| 1. Guided local request demo | Extend the web home and editor entry points, engine templates, API, database and seed. Store template setup progress and a request record with a stable reference tied to its owner and live submission. Reuse existing run and version records. | From a fresh install, a beginner can preview, leave a draft, resume, turn it on, submit the form and find the resulting record and demo receipt. Preview and double-clicks create zero and one live request respectively. |
| 2. Client profile, Gmail and website handoff | Add profile and encrypted sender records scoped to the workspace owner. Extend API settings, the worker mailer, setup screens, hosted form handoff and threat model. Cover existing email steps and approval mail when resolving the sender. | Two owners send through their own accounts. Disconnecting one cannot affect the other. The seeded demo still sends locally. Document the manual live Gmail check separately from fixture tests. |
| 3. Sheets and Slack | Add provider adapters, connection and destination settings, delivery tracking, and fixture-based API and worker tests. Map each action to a stable request reference and record the provider result. | Handle expired access, permission denial, quotas and retries independently. If the sheet write succeeds and Slack fails, retry Slack alone. If a provider may have accepted a timed-out call, reconcile it or ask for review before repeating it. |
| 4. Office teams and named approvals | Extend auth, database membership and approval records, API access checks, and the approval page. Define owner, operator, requester and approver permissions. Migrate existing owners and handle outstanding links explicitly. | Verify the signed-in approver server-side. A forwarded link, repeated answer, or different workspace cannot authorize a purchase. Record who decided and when. |
| 5. Microsoft offices and pilot templates | Add Outlook and Teams adapters and a template for a pilot office. Use existing consent and delivery patterns. Extend business templates and end-to-end fixtures for the selected task. | Verify administrator-denied consent, reconnection, and delivery status. A client can follow a request from its form to its destination without opening the editor. |
| 6. Expand from observed demand | Add one of the task, sales, calendar or booking integrations above with its template and tests. Document the provider events and changes in its data contract. | A pilot user completes the real task. Confirm what happens to duplicate, updated and cancelled events before enabling automatic follow-ups. |

Across phases, keep existing advanced URLs and workflow versions usable. Protect public forms with validation and rate limits. Keep private request details behind sign-in. Store only the data needed for each task. Update [how it works](how-it-works.md), the [threat model](threat-model.md) and relevant decision records as behavior ships. Run lint, typecheck, unit and API tests, Playwright, security checks and a clean Compose startup before marking a phase complete.

## How to tell whether the new UI helps

Give someone who has never used an automation builder this task: “Set up a way for a colleague to report a broken printer. Show me what they would receive, turn it on for the demo, and find their request.” Start with a fresh account. Do not tell them which buttons to press.

- Record whether they finish unaided, where they hesitate, and whether they can explain the difference between previewing and sending. A person who accidentally sends a live message has found a release-blocking problem with that flow.
- Ask them to come back on another day, change the notification destination, and find a failed delivery. Check whether they can recover without sending a second receipt or creating a second record.
- Repeat the core path on a phone and with a keyboard. Automate the stable path in Playwright and keep human observations separate from automated test results.
- For the AI work already in progress, verify provider switching and test billing and general inquiries against a real local model. Record the examples and observed routing before making accuracy claims. Guided request tracking must also work with AI disabled.

## Release scope and acceptance checks

### What to deliver in this handoff

Deliver roadmap phases 1 through 5 in order, with one reviewable commit per phase. In PROJECT.md give follow-up phases their own checklist after the original completed phases. Use office request tracking and website inquiries for the first two demos. Use purchase request intake with a named approver as the Microsoft office template. Complete the Sheets, Slack, Outlook and Teams actions listed in the connection table, including their setup screens and error handling. Additional task, CRM, calendar and booking connections in phase 6 depend on the chosen pilot. Keep them in the backlog until the owner selects one.

Treat the current working copy as the starting point. It contains in-progress AI settings work, tests and database migration 0005. Inspect the migration journal and pending changes before allocating the next migration. Keep those changes together and review their tests independently of the office features. Use the existing API, worker, database, editor and seed throughout.

### Decisions the implementer can use directly

| Situation | Required behavior |
| --- | --- |
| A colleague asks who is handling a request. | Give the operator a **Requests** list inside **Track an office request**. Each row has a reference, subject, date, owner and status. Let an authorized operator claim it, mark it done and reopen it. **Activity** records deliveries, failures and changes. A successful email leaves the business request open until someone completes it. |
| Someone double-clicks Submit or their phone retries after a timeout. | Generate a submission key per form attempt. On the server, save the request and its queued work atomically, and enforce uniqueness in the database. A retry with the same key returns the same reference. Two intentional requests with the same wording get separate references. Treat references as identifiers. A reference by itself grants no access to private details. |
| A preview looks like a real submission. | The preview has a persistent **Preview only** heading, sample destinations and no external side effects. The connection test is separate and shows the exact real destination. If access is denied or setup is abandoned, retain the draft and return the owner to the same step. |
| A Gmail test asks for a “verified address”. | The current user model stores a sign-in email without mailbox verification. During sender setup, send a rate-limited one-time link to the authenticated Gmail sender's own address. Claim it from the owner's signed-in setup session before enabling live email. Expire it, allow one use, and use Mailpit for the local version. |
| Someone edits a live automation or pauses its form. | Save edits as a draft until the owner turns on that version. Pausing blocks fresh form, schedule, manual, webhook and MCP starts for that automation. Previously accepted runs retain their version and continue. A disconnected credential blocks affected deliveries even on existing runs. Resuming admits new work once. |
| A custom workflow is opened in guided setup. | Offer guided editing only for settings the template can round-trip. Preserve unknown steps and expressions. When a custom definition cannot be edited safely, show its summary and offer **Open advanced editor**. |
| A receipt or spreadsheet write might already have succeeded. | Display the last confirmed outcome and the provider reference when available. A retry acts on the failed action. For an ambiguous result, offer an operator check before resending. Opening the public request link, refreshing Activity or retrying another action must never send a second receipt. |
| A staff member changes roles or forwards an approval link. | Recheck workspace membership, assigned approver and request state at decision time. Test removed members, forwarded links, expired answers and concurrent decisions. Keep private fields out of channel messages and the public confirmation page. |

### What the owner should receive

1. **A runnable project and demonstrable change.** On a clean, disposable Compose project, follow the README quickstart and seed command. Walk a fresh account through first setup. Also sign in as the seeded owner to inspect a request needing action, a completed request and an interrupted delivery. Running the seed twice must yield the same demo records.
2. **Evidence from the current revision.** Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` and the security checks in the existing CI workflow. Exercise an upgrade from the prior schema using disposable data containing an existing owner, workflow, run and saved key. Include outcomes, failures and anything unavailable. Count remote CI as green only after observing a run for this revision.
3. **An integration status table.** For each provider list the action, setup needed, fixture test result, live result and any remaining owner step. Missing credentials should leave live verification pending while local implementation and contract tests continue. Keep real client email and channel traffic out of routine test suites.
4. **A five-minute walkthrough the owner can repeat.** Include the demo login, form link or where to copy it, how to find the receipt in Mailpit, how to close a request, and how to recover a failed notification. Capture the shipped desktop and mobile screens. Report usability observations only if a person actually attempted the task.
