# Manual live Meta Messenger and Instagram check

The automated tests never contact Meta. They use local fakes in `test/fake-providers.ts` and signed synthetic webhooks. Run this check by hand against a Meta Developer app and a test Facebook Page (and linked Instagram Business Account, if used). Never paste a Page Access Token, App Secret, or Verify Token into a ticket, chat, or this file.

Status: not run yet. Record the date, the kymavo commit, and what you saw under Results when you run it.

## Prerequisites

1. A Meta Developer app with Messenger (and Instagram, if testing IG DMs) added.
2. A Facebook Page linked to that app, its numeric Page ID, and a Page Access Token.
3. The app's App Secret and a random Verify Token you choose (at least 6 characters).
4. kymavo running behind a public HTTPS URL (for example a Cloudflare Tunnel) configured as `PUBLIC_URL`.
5. For testing before Meta App Review: add your own Facebook or Instagram account as a Tester or Developer role in the Meta app. Live messaging to outside customers requires Meta App Review approval for `pages_messaging` and `instagram_manage_messages`.

## Steps

1. In kymavo, open Apps and select Facebook Messenger & Instagram.
2. Enter the Page ID, optional Instagram Business Account ID, Page Access Token, App Secret, and Verify Token, then save. Expect status Connected and a Webhook URL ending in `/hooks/meta/<path>`.
3. Select Test connection. Expect Meta to accept the Page access token and confirm the Page name.
4. Copy the Webhook URL into Meta Developer Dashboard under Messenger (and Instagram) Webhooks, enter the same Verify Token, and click Verify and save. Expect Meta to accept the `hub.challenge` response.
5. Subscribe the webhook to `messages` events for the Page (and Instagram account, if linked).
6. Create an automation from the "FB and IG receipt check" template (or a minimal `meta_dm` -> `meta_reply` workflow), connect Google Drive, Google Sheets, and a vision-capable AI model if using the full template, and publish it.
7. From a tester account, send a direct message with a sample GCash or bank receipt photo to the Page (and to the Instagram account, if linked).
8. Expect one run in Activity with the downloaded receipt image stored in uploads, extracted receipt fields, and a Google Sheets row marked "Pending verification".
9. Send the same receipt photo a second time in a new message. Expect the second run's AI output and approval message to show the duplicate reference warning.
10. Approve the first run in kymavo and confirm the reply arrives in Messenger or Instagram within the 24-hour window.
11. Confirm that `GET /runs/:id`, `GET /deliveries`, `GET /settings/connections`, and server logs contain none of the Page Access Token, App Secret, or Verify Token.
12. Disconnect Facebook Messenger & Instagram in Apps and confirm incoming webhooks are rejected with 403.

## Results

None recorded yet.
