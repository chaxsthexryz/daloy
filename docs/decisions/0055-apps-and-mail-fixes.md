# 0055: Apps and mail fixes from the November security review

## Context

The [19 November security review](../security-review-2026-11-19.md) found seven medium issues in AI settings, approval mail, run history, Google Calendar, incoming mail and Airtable (roadmap N11c-3): M7, M8, M9, M11, M12, M13 and M16. The review read the source and ran nothing, so each fix starts with a test that reproduces the consequence it describes.

Migration `0034_apps_and_mail_fixes` adds the columns below. It follows N27's `0033_booking_no_show`, and this branch also adds the snapshot that migration lacked, so drizzle-kit diffs from the right base.

## Plan and decisions

M7, AI settings test. The test route now claims one AI action before it calls the model, the same as Build with AI and Ask. At the monthly limit it answers 429 and makes no provider call. Counting it for a workspace's own key too keeps one rule for every AI call. Left open: a separate operator spend ceiling for paid attempts across all workspaces. That is an installation budget and needs its own design.

M8, approval email. The step resolves the final recipient list first (the named approver, or the link-holder list), checks it with the email step's own `checkRecipients`, claims one email unit per address, and sends to that same list.

M9, history views. One read-time hider (current and retired secret values, then secret-looking keys) now serves run detail, the run list, the office request list, delivery activity and the MCP run status. Calendar errors no longer store the text Google sends back: only Daloy's own fixed message with the status code.

M11, calendar destination. A calendar event remembers the account and calendar it was last written to (`calendar_events.account`, `calendar_id`). Every later sync for that booking is pinned there instead of to the connection as it is now. When the connection has moved to another calendar, the existing destination check stops the sync in review and says the event is still in the old calendar. Post again is the owner's explicit choice to write to the new calendar; the event then binds to it. Existing events are bound by the migration to the calendar of their last delivered sync.

M12, overlapping calendar writes. A calendar sync now reads the booking under the same share lock other deliveries use (decision 0032), held until Google answers. A cancel or reschedule cannot commit while an older write is in flight, so the sync it queues always runs after that write and makes the event match the booking as it is. A write whose answer was lost is queued again with check first, and the retry reads the booking again, so it reconciles to the latest version.

M13, incoming mail fairness. The poller takes live sources (a published email trigger) before drafts, and among those the workspace whose mailboxes were checked longest ago first. A workspace is polled by at most one worker at a time. A transient failure doubles the wait before the next poll (`email_sources.failures`), up to one hour, and a successful read resets it. No explicit cap on pending checks per workspace: drafts only get a turn when no live source is due, and failing drafts back off, so they cannot hold back another office's live mailbox.

M16, Airtable table names. Connecting Airtable now needs the table id (`tbl...`), which stays the same when a table is renamed. A connection saved earlier with a table name no longer delivers: its queued records fail with a message to reconnect with the table id, then retry. After reconnecting, the destination check sends them to review, and Post again sends them to the confirmed table.

## Consequences

- The AI settings test costs one AI action.
- An approval to several addresses costs one email unit per address.
- A Calendar error shows the status code and Daloy's hint, without Google's own wording.
- A calendar sync can hold a booking's row lock for up to the Google timeout (10 seconds), so a staff cancel can wait that long.
- An owner who connected Airtable by table name has to reconnect it before records are delivered again.
- A draft mailbox that keeps failing is checked at most once an hour until it succeeds or is saved again.
