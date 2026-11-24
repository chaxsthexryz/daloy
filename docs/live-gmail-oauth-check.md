# Manual live check: Gmail through Connect with Google

The automated tests never contact Google. They use the fake Google OAuth app and the fake Gmail API in `test/fake-providers.ts`. Each behaviour below is unverified until someone runs this page against a real Google account and records the result ([decision 0063](decisions/0063-gmail-oauth.md)). The app password path has its own page, [live Gmail check](live-gmail-check.md).

Status: not run yet. Record the date, the kymavo commit and what you saw under Results when you do.

## Before you start

- The `daloy-dev` Google Cloud project from the [live Google OAuth check](live-google-oauth-check.md): consent screen in Testing, your Google account listed as a test user, a Web application OAuth client with the redirect URI `http://localhost:3000/settings/connections/oauth/callback`.
- The Gmail API turned on in that project, and `https://www.googleapis.com/auth/gmail.send` added to the consent screen's scopes (Data access). Google lists it as sensitive; while the project is in Testing that needs no review.
- In `.env`: `OAUTH_ENV=development`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`. Type the values yourself; never paste them into a chat, an issue or a commit. Leave `GMAIL_API_URL` unset.
- kymavo running on `http://localhost:3000` with a test workspace. Do not use a workspace that holds real QA data you need, and do not reset or reseed the database to run this.
- A second Google account for step 6, and a mailbox you can read to receive a customer's copy.
- A Gmail account whose password you may change (step 8). Use a test account, not your main one.

## Steps

1. Consent. Open Apps, then Gmail. Expect Connect Gmail with Google as the main button, the line that kymavo cannot read your mail, and the app password form under "Advanced: use a key or token instead". Select Connect Gmail with Google. Expect Google's consent screen to name your dev app and ask only to see your email address and to "Send email on your behalf". Note whether Google shows an "unverified app" warning. Allow. Expect "Gmail is connected.", your address in lower case and "Sending from this address", with no confirmation link to open.
2. Narrower grant. Disconnect, connect again, and untick the send permission if Google offers a checkbox. Expect "Some of the permissions kymavo asked for were not allowed" and nothing connected. Connect again with everything allowed.
3. Test email. Select Send a test email to me. Expect "Google accepted a test email to <your address>". In your Gmail Sent folder and inbox, check the message: From shows your business name and address, Reply-To is the reply address from Business, and the text matches. Open "Show original" and note whether Google kept kymavo's `Message-ID` (`<test.<uuid>@daloy>`) or replaced it.
4. A real send. Turn on Website inquiries (Business) and send an inquiry with your other mailbox as the customer. Expect the reply in that mailbox from your Gmail address, and the run's email step showing your address as the sender. Compare the reply's headers with one sent through the app password path (step 5 of the [live Gmail check](live-gmail-check.md)) if you have one.
5. Branded email. Upload a logo and set an accent colour in Business, then send another inquiry. Expect the HTML part with the logo shown inline and the plain text part with the business name line.
6. Another Google account. Select Reconnect Gmail and sign in with the second Google account. Expect the address on the card to change to that account's address and the next test email to come from it.
7. Rate limits. Optional and slow: Gmail's sending limits are per account per day. Do not try to reach them on a real account. Record only whether any run in this check failed with "Gmail is limiting how much this account can send right now", and its Retry-After if a run shows one.
8. Password change. Change the Google account's password at https://myaccount.google.com/security. Send an inquiry. Expect the run's email step to fail with "Gmail no longer accepts kymavo's access, so nothing was sent. Reconnect Gmail in Apps.", the card to read "Google no longer accepts kymavo's access" and "Reconnect Gmail to send again", and no email from any other address (check Mailpit at http://localhost:8025 and the other mailbox). Note whether the first failure came from the API (a 401 on a still unexpired access token) or from the refresh (`invalid_grant`). Reconnect Gmail and expect the next test email to go through.
9. Disconnect and revoke. Select Disconnect. Expect the card to show Connect Gmail with Google and "Mail from your automations is paused until you reconnect Gmail", with no warning that Google did not confirm. Open https://myaccount.google.com/permissions and expect your dev app gone, or note what Google shows. Send an inquiry: expect a failed run saying Gmail is disconnected, and no email anywhere.
10. Back to the installation server. Select Use the local mail server instead. Expect the card to say your automations send from the installation's server.
11. Expiry in Testing. Refresh tokens of a project in Testing last seven days. After seven days, send a test email and expect "Reconnect Gmail".
12. Inbox trigger. Check that an automation that starts when an email arrives still asks for its IMAP mailbox and app password, and was not changed by any of the above.

## Sensitive scope verification (production)

`gmail.send` is a sensitive scope (confirmed in plan section 8). Before Gmail sign-in is offered to customers on the production client, follow plan section 8 steps 5 to 7:

- The production consent screen must be In production, with a verified authorized domain, a homepage that explains the Gmail feature, a privacy policy and terms of service, and brand verification done (step 2 of section 8).
- Submit `gmail.send` with a justification that says kymavo sends the owner's automation email (inquiry replies, booking confirmations, approval requests) from the owner's own address, never reads mail, and asks for no other Gmail scope. Name the alternatives considered: SMTP with OAuth needs the restricted `https://mail.google.com/` scope; reading mail is not offered.
- Record a demo video of the consent screen and of steps 1, 3 and 9 above on the production client (whether Google requires a video is unverified, plan section 15 item 6).
- Review takes up to 10 business days (confirmed); plan for a round of questions. Until approval, an app that requests a sensitive scope is capped at 100 users (confirmed), so keep Gmail sign-in for test users only.
- Any later Gmail scope needs a new approval before it can be used, and `scopes.test.ts` fails until the manifest, decision 0063 and the submission are updated together.

## Results

Not run yet.
