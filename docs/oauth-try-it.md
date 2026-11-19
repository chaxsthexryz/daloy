# Trying the managed OAuth apps yourself

The OAuth work (plan phases P0 to P8) is on branch `oauth-p8-integration`. Everything in it was tested only against fake providers. This page is the order to try it with real accounts. Each app's full steps are in its `docs/live-*-check.md` file; write the result under that file's Results heading (pass or fail, date, a short note, never a token or a callback address with `code=` in it).

## 1. Run the branch without touching your QA data

Your Docker stack on `localhost:3000` holds QA data. The branch adds migrations 0037 to 0039, which are additive, but there is no rollback, so run the branch as its own Compose project with its own database instead of rebuilding your stack.

1. Stop your stack (it keeps its data): in `<repo-root>`, run `docker compose stop`.
2. Copy your `.env` into `../daloy-oauth-p8` and add the client values for the apps you want to try (section 2). Type secrets yourself; never paste them into a chat, an issue or a commit.
3. In `../daloy-oauth-p8`, run `docker compose up -d --build`, then `docker compose exec api node_modules/.bin/tsx src/seed.ts`. The folder name makes Compose use a separate project and a separate database volume.
4. Sign in at `http://localhost:3000` as `demo@daloy.local` (password `daloy-demo-2026`). Mailpit is at `http://localhost:8025`.
5. When you are done: `docker compose down` in `daloy-oauth-p8` (add `-v` only if you want that test database gone), then `docker compose start` in `daloy` to get your stack back.

Every provider needs the same redirect URI: `http://localhost:3000/settings/connections/oauth/callback` (Outlook also accepts its older `/settings/connections/outlook/callback`).

## 2. What to put in `.env`

```
OAUTH_ENV=development
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_PICKER_API_KEY=
GOOGLE_PROJECT_NUMBER=
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
AIRTABLE_CLIENT_ID=
AIRTABLE_CLIENT_SECRET=
NOTION_CLIENT_ID=
NOTION_CLIENT_SECRET=
TRELLO_CLIENT_ID=
TRELLO_CLIENT_SECRET=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
```

Leave a pair empty to skip that app; its card keeps the paste form. `OAUTH_ENV=development` is required once any client except Microsoft is set, and it only works with a `localhost` `PUBLIC_URL`. After changing `.env`, run `docker compose up -d api worker`.

## 3. Gmail, step by step

Do this first if Gmail is what you most want to try. It uses the same Google project as Sheets, Drive and Calendar.

Google Cloud console, once:

1. Create a project named `daloy-dev`.
2. APIs and services, Library: turn on the Gmail API (and the Sheets, Drive, Picker and Calendar APIs if you will try those).
3. Google Auth platform (OAuth consent screen): choose External, leave it in Testing, and add your Google accounts as test users. Use a test Google account for Gmail, because step 8 below changes its password.
4. Data access: add `openid`, `email` and `https://www.googleapis.com/auth/gmail.send`. Google lists `gmail.send` as sensitive; in Testing that needs no review. Add no other Gmail scope.
5. Clients: create an OAuth client of type Web application with the redirect URI from section 1. Copy the client id and secret into `.env` as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, and set `OAUTH_ENV=development`.
6. `docker compose up -d api worker`.

In Daloy (the full list with what to expect is [live Gmail OAuth check](live-gmail-oauth-check.md)):

1. Apps, Gmail: select Connect Gmail with Google, pick the test account, read the consent screen (it should ask only to send email on your behalf), and allow.
2. Back on Apps, the Gmail card shows the address. Select Send a test email to me and check it arrived from that address, with your business name.
3. In Business, turn on Website inquiries and send an inquiry from another mailbox. The reply should come from the Gmail address.
4. Reconnect with a second Google account: the card's address changes and the next test email comes from it.
5. Untick the permission on Google's screen if it offers a checkbox: expect "Some of the permissions Daloy asked for were not allowed" and nothing connected.
6. Change the test account's password at `https://myaccount.google.com/security`, then send an inquiry. Expect the email step to fail with Reconnect Gmail, nothing sent from any other address, and, within a minute, one email to the owner's login address in Mailpit titled "Reconnect Gmail in Daloy" (R8). It comes through the installation's server because Gmail cannot send it.
7. Disconnect: the card returns to Connect Gmail with Google. At `https://myaccount.google.com/permissions` check that Daloy is gone, or remove it.
8. Check that an automation that starts when an email arrives still asks for an IMAP mailbox and app password.

Refresh tokens of a project in Testing last seven days, so after a week expect Reconnect Gmail. That is Google's Testing limit, not a fault.

## 4. The other apps, in this order

1. Google Sheets and Drive: [live Google OAuth check](live-google-oauth-check.md). Needs the Picker key and project number for Pick. Step 11 (two Daloy workspaces on one Google account) settles R14: the card should now warn that the account is connected elsewhere, and the check says whether disconnecting one really ends the other.
2. Google Calendar: [live Calendar OAuth check](live-calendar-oauth-check.md). First note the label Google shows for `calendar.app.created` on the Data access page; the [submission pack](google-scope-submission.md) needs it.
3. Slack: [live Slack OAuth check](live-slack-oauth-check.md).
4. Airtable, Notion and Trello: [live records OAuth check](live-records-oauth-check.md).
5. Outlook and Teams: [live Microsoft check](live-microsoft-check.md).
6. Telegram, Teams and PayMongo guided pastes: open each card in Apps and follow the guided steps with a test bot, a test channel and PayMongo test keys.

For any app, a broken grant (revoked at the provider) should produce one "Reconnect <app> in Daloy" email a day in Mailpit (R8). An account connected in two places should show the shared-account note on its card and in the Disconnect confirmation (R14).

## 5. When you are happy

Merge `oauth-p8-integration` into main yourself. Before customers use Gmail or Calendar on a public address, Google has to review the sensitive scopes: [submission pack](google-scope-submission.md).
