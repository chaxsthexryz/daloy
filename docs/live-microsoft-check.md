# Manual live Outlook and Teams check

The automated tests never contact Microsoft. They use `test/fake-providers.ts`, a local server that plays the Microsoft sign-in pages (consent, an administrator requirement, a refusal, PKCE, rotating refresh tokens), Graph `/me` and `/me/sendMail`, and a Teams Workflows trigger, and can answer with 401, 403, 429, 404 or a timeout after accepting a send. This page is the separate check against real accounts. Run it by hand with accounts you control.

Status: not run yet. No Microsoft account was available when roadmap phase 5 was built. Record the date, the Daloy commit and what you saw at the end of this file when you do.

## Before you start

- A Microsoft 365 work account with an Exchange Online mailbox and Teams. A free Microsoft 365 developer sandbox works if you can get one; there is no paid step in Daloy.
- An Entra app registration (Entra admin center, App registrations, New registration). Supported account types: accounts in any organizational directory. Redirect URI (Web): `http://localhost:3000/settings/connections/outlook/callback`, or your `PUBLIC_URL` with the same path. Under Certificates and secrets, create a client secret. Under API permissions, add Microsoft Graph delegated `Mail.Send`, `User.Read` and `offline_access`.
- Daloy running with `docker compose up`, with `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` set for the API and the worker.
- In Teams, a team and channel, and a workflow from the template "Post to a channel when a webhook request is received" for that channel. Copy its link.

## Steps

1. Sign in, open Business and email. Expect the Outlook panel to list the permissions and the administrator note with a link, before any button takes you to Microsoft.
2. In the tenant's Enterprise applications, User consent settings, set "Do not allow user consent". Select Connect Outlook as a non-admin. Expect Microsoft's "Need admin approval" page, and back in Daloy (if Microsoft returns there) "Your organization only lets an administrator approve new apps".
3. Open the administrator link as an admin and approve. Expect Daloy's "An administrator approved Daloy" message. Select Connect Outlook again. Expect the mailbox address and Connected.
4. Select Send a test email. Expect the email in that mailbox's inbox and in Sent Items.
5. Paste the Teams workflow link and the channel name, select Connect Teams and Send a test message. Expect the card in the channel within a minute.
6. Set up purchase requests with an invited approver, tick Outlook and Teams, turn it on, and send a request through the form. Expect the receipt from the Outlook mailbox, the approval email to the approver, and on Approve one email to purchasing, one Teams card with the reference and item only, and one email to the employee. The Requests list shows each delivery.
7. In the user's My Account, Apps, remove Daloy's access (or revoke sessions in Entra). Send another request and approve it. Expect "Reconnect Outlook" on the Outlook emails and the connection marked as needing reconnecting. Reconnect, select Retry on one email, and expect it once.
8. Turn the Teams workflow off. Approve another request. Expect the Teams note failed with "deleted or turned off". Turn it back on, paste the link again if Teams changed it, and select Retry.
9. Set "Who can trigger the flow" to "Any user in my tenant". Send a test message. Expect the message about signed-in callers.

## Results

None recorded yet.
