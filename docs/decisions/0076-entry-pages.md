# 0076. Entry pages: one split layout, light only, client checks before requests

## Context

The approved E1 to E5 frames show the signed-out pages on one split layout (dark pitch panel, white form side), and E6 shows My requests as a top bar over a table card. The old pages were separate centered forms. Several frame details go past what the code did: an approval-waiting note on the sign-in page, a short-password message on registration, the used-link and existing-account errors beside the field, and words for run states on My requests.

## Options

1. Restyle each old page in place.
2. One `AuthLayout` for E1 to E5, with `AuthNote` for status and error messages, and a separate light page for E6.
3. Add API routes to preview an invite or reset link so an invalid link can be shown before the person types.

## Decision

Option 2. The pages stay light only, as the old sign-in page was, because a signed-out person has no saved theme. The approval note shows only for `#/answer/<token>`, which `App.tsx` already read to hand over to `/approvals/<token>` after sign in; the server still checks that the person is the named approver. The 12 character minimum is checked in the browser through `checkNewPassword` (the same limits as the API) before registration, reset and join, so the reason sits beside the field and no request is sent. Used, expired and existing-account cases keep the API's own message, shown under the password field. Run states on My requests go through `requestStatus` (Received, In progress, Waiting, Needs review, Succeeded, Failed, Cancelled), and an unknown state shows as it came.

Option 3 is not done. A preview route would tell a stranger whether a token exists, and the frames show the error after Join, so the cost is not needed.

## Consequences

- The toggle on the sign-in page is now named "Create an account", so about 40 specs that clicked "Create an account instead" use the new name.
- Single-use and expiring links, the same answer for unknown emails, rate limits and the named-approval check are unchanged. No API route changed.
- Pre-login pages are English only. Taglish applies to My requests after sign in (`lib/locale-entry.ts`).
- The short-password text ("Password must be at least 12 characters.") is the frame's wording, not a server message. If the server's zod message changes, the browser check still shows the frame text first.
