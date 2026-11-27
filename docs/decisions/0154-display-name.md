# 0154. Display name

## Status

Accepted

## Context

The sidebar, the Team list and the approval screens showed a person's email, because the email was the only thing kymavo knew about them. The owner asked why the lower-left block shows an email and not a name. A person belongs to exactly one workspace through `workspace_members`, and that row only holds a role, so a name stored per membership would have to be copied whenever someone joined.

## Options

1. A column on `workspace_members`. Matches where the role lives, but the name is a fact about the person, and the members list is not the only place a person appears (approvals, payment history, run history).
2. A column on `users`. One place to write, and every query that already joins `users` for the email can read it.
3. A separate profile table. More structure than one optional text field needs.

## Decision

Option 2. `users.display_name` is nullable text with a CHECK of 1 to 60 characters, so an empty or padded value cannot be stored. `PUT /auth/profile` with `{ displayName: string | null }` is open to every signed-in role and changes only the caller's own row. The input is trimmed, must be 1 to 60 characters, may not contain control characters (`\p{Cc}`, so no newline or tab), and unknown fields are refused. An empty string is a 400; `null` clears the name, and the web form sends `null` for an empty field.

`GET /auth/me`, sign-in, sign-up and invite accept return `displayName`. The web falls back to the email when it is null: `personName()` in `apps/web/src/lib/person.ts`.

Where a name replaces the email on screen:

- Sidebar account block: the name with the role beside it, the email as the `title` of the name. Same for the avatar initial and the My requests header.
- Team list: the name, with the email in smaller text beside it. Dialogs that change or remove a member still name the email, since that is the precise target of a destructive action.
- Inbox: "Assigned to" uses the name. The public approval page shows "signed in as" with the name.
- Payment review (reviewer, confirmer, history actor) and the morning digest use `coalesce(display_name, email)` in SQL.
- Run history: a decided approval stores the decider's email in the step output when it is decided. `GET /runs/:id` swaps in the current name when one is set, so the stored record keeps the email and a later rename still shows.

Unchanged on purpose: the sign-in and invite email fields, the Account card that says which email you signed in with, the Admin pages, invite lists, and the approval emails (they are addressed to an email).

## Consequences

- Names are not unique and are not verified. Two people can use the same name, and a person can type someone else's. The email stays reachable as the tooltip, in Team, and in the Account page, so the name is a label and never an identity check. Named approvals still match on the user id.
- The public approval page builds HTML by hand, so the name goes through `escapeHtml`. React escapes it everywhere else.
- The name is not copied into audit snapshots (`approvals.decided_by_email`), so renaming changes how old history reads but not what was recorded.
- Migration `0062_display_name.sql` adds one nullable column and one CHECK. Existing rows keep null and look as before.
