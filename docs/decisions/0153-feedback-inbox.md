# 0153. Feedback inbox

## Status

Accepted

## Context

A member who hits a problem or has an idea had no way to tell the operator from inside the console. The help menu only said to message the operator by some other channel. The operator needs one list of what arrived, a way to answer, and a record of who answered what. Phase A3 builds the operator's side as a separate `/admin` app, so this phase supplies the table and the routes it uses.

## Options

- Email only: a form that mails the operator. No history for the sender, no status, nothing to audit.
- A free-form thread per message: replies both ways. More to build, and the operator already answers by email.
- One row per message with a single operator reply: enough for a list, a reply box and Close.

## Decision

One `feedback` table (migration `0063_feedback.sql`): `workspace_id` and `sender_id` (both `users.id`, cascade), `topic` (bug, idea, question, billing, other), `message` (1 to 2,000 characters), `status` (new, replied, closed), `reply` (at most 2,000), `replied_at`, and timestamps. Topic, status and lengths are CHECK constraints, so a bad value cannot get in by any route. Indexes: `(status, created_at)` for the operator's list and `(workspace_id, created_at)` for a workspace's own list.

Member routes, any role: `POST /support/feedback` (zod body, 5 per hour per user with `RateLimit`) and `GET /support/feedback` (everything sent from the caller's workspace, newest first, with replies). Colleagues in a workspace see each other's messages and the replies, since a reply may answer a team problem.

Operator routes behind `AdminGuard` (404 unless the session's email is in `PLATFORM_ADMINS`, and writes need the page's own origin): `GET /admin/feedback?status=`, `PUT /admin/feedback/:id/reply`, `PUT /admin/feedback/:id/close`. The list answers `{ items: [{ id, workspaceId, workspaceName?, senderEmail, topic, message, status, reply, createdAt, repliedAt }] }`. `workspaceName` is the business name and is left out when the workspace has none.

A reply is saved first, then mailed to the sender through the installation's mail server (the same one used for password resets), in the workspace's language. If sending fails the reply stays saved and the response carries `emailed: false`, so the operator can follow up another way. A closed message refuses a reply with 409. Replying again to a replied message replaces the reply and sends it again.

Each reply and close inserts an `admin_actions` row (`feedback_reply`, `feedback_close`) in the same transaction as the change, with `{ feedbackId, status }` before and after. The audit row never holds the message or the reply text. The `admin_actions_action` CHECK list gained those two values.

The workspace page is `#/feedback`, linked from the Help menu and, for approvers and requesters, from the bar on My requests.

## Consequences

- No new dependency and no external service. The reply mail goes only where the installation's SMTP is configured.
- The in-memory rate limit counts per API process (as every `RateLimit` does). Several API instances would each allow 5.
- Feedback text is stored as sent. It is shown as plain text, never as HTML.
- A person who is removed from a workspace keeps their old messages in it; deleting the user account deletes them.
