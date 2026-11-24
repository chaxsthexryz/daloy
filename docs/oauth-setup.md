# Owner setup for managed OAuth (phase P0)

This is the checklist you follow once to register each provider's OAuth app and put the values in the server environment. It belongs to `docs/plans/managed-oauth-plan.md` (section numbers below refer to it). No kymavo code reads these variables yet; P1 and later phases add that. Registering the apps first lets each provider phase be tested as soon as it lands.

Status: not run yet. Record the date and what you saw at the end of this file.

## Read this first

- Provider consoles change. No console menu name or button label is written here, because the provider sites could not be opened when this was written. Each step says what you need to end up with and links the provider's documentation page from plan section 15. Where a detail is marked "check the console, this may have changed", confirm it on the live page before relying on it.
- Tags are copied from the plan: **confirmed** means official documentation said it in the plan's search results on 18 November 2026, **unverified** means it was not confirmed.
- One OAuth app per provider per environment. Never share a client between dev and prod (plan 5.1).
- Client secrets go in the server environment only: `.env` on the host, never the database, never git, never a chat, a ticket or a screenshot. Type them yourself. The examples below use placeholders such as `<paste from console>`.
- Free rule flags that affect your choices (plan section 9):
  - A domain you own is probably needed for Google and Microsoft verification, and a domain costs a yearly fee. This is the one likely paid item. `pages.dev` probably cannot be verified as an authorized domain (unverified). Decide this before you start (plan question 1).
  - Do not request restricted Google scopes (`gmail.readonly`, full `drive`, `https://mail.google.com/`). They need a paid yearly security assessment (confirmed). The plan avoids them by design.
  - Whether a Google Cloud project can be created without a billing account is unverified. You have already accepted a card for the VM.
  - The Microsoft Partner Center account is free but needs your business verified (paperwork, not money).
  - The Slack Marketplace is not used. Read Slack's commercial distribution terms before you charge customers for an unlisted app (plan question 8).

## What you do and what kymavo does

| You (once, by hand) | kymavo (built in later phases) |
|---|---|
| Choose and buy the domain, host the homepage, privacy policy and terms pages | Serves the app at `PUBLIC_URL` and builds every redirect URI from it |
| Create the dev and prod apps at each provider | Shows a "Connect with X" button only when that provider's client id and secret are set |
| Request Google brand verification and, later, sensitive scope review | Requests only the scopes in its in-code manifest and refuses a grant that is narrower than required |
| Copy client ids and secrets into `.env` for dev and prod | Reads them at boot, never stores them in the database, never logs them |
| Set `OAUTH_ENV` to match the host | Refuses to start when `OAUTH_ENV` and `PUBLIC_URL` disagree |
| Keep client secrets' expiry dates in a calendar | Stores customers' tokens encrypted, refreshes them with a lock, revokes on disconnect |
| Run the live checks in `docs/live-*-check.md` | Runs only against the fake providers in tests |

## 1. Decisions to make first

1. Domain: one domain for the app, the policy pages, and the Google and Microsoft apps (plan question 1, recommendation yes). Write it down as `<your domain>`.
2. The production host, for example `https://<production host>`. This is your production `PUBLIC_URL`.
3. A support email address on that domain. Airtable requires one (confirmed). Others may ask for it (check the console, this may have changed).
4. Whether the production apps are owned by you (plan question 2, recommendation yes). Self-hosted installs register their own clients.

## 2. Domain and the policy pages

Google, Airtable and Slack require a privacy policy and terms (plan section 9, item 7; Airtable requires a privacy policy URL, terms URL and support email, confirmed; for Google the requirement is from memory, unverified in detail; Slack, check the console).

You need these pages on the production domain, public, no login:

- A homepage that says what kymavo is and which Google features it uses and why. Google asks for this (plan 8, step 1, unverified in detail).
- A privacy policy that matches what kymavo really does. At minimum it should say: what account data kymavo reads from each connected provider, what it stores (encrypted tokens, the connected account name), what it does with it (runs the owner's automations), who it shares it with, how long it keeps it, how a customer disconnects and revokes access, and how to contact you. If kymavo uses Google user data, check Google's current user data policy wording in the console before publishing, this may have changed.
- Terms of service that say who may use the service, what you provide and do not provide, and how to contact you.
- Both pages linked from the homepage and from the consent screens.

Do not copy legal text from another site. Someone must write these and they must be true. Hosting them on the existing Pages site is free.

Dev does not need its own domain. Dev apps use `http://localhost:3000` redirects and test users.

## 3. Environment variables

These are the exact names from plan 5.1. Put them in the `.env` of each environment (see `docs/deployment.md` for the production file and `.env.example` for the layout). The API and the worker both need them, as with the existing Microsoft values.

```
# Which environment this server is. Must match the host in PUBLIC_URL.
OAUTH_ENV=development            # or production

GOOGLE_OAUTH_CLIENT_ID=<paste from console>
GOOGLE_OAUTH_CLIENT_SECRET=<paste from console>
GOOGLE_PICKER_API_KEY=<browser key, restricted by referrer>
GOOGLE_PROJECT_NUMBER=<project number, digits>

SLACK_CLIENT_ID=<paste from console>
SLACK_CLIENT_SECRET=<paste from console>

AIRTABLE_CLIENT_ID=<paste from console>
AIRTABLE_CLIENT_SECRET=<paste from console>

NOTION_CLIENT_ID=<paste from console>
NOTION_CLIENT_SECRET=<paste from console>

TRELLO_CLIENT_ID=<paste from console>
TRELLO_CLIENT_SECRET=<paste from console>

# Existing, unchanged
MICROSOFT_CLIENT_ID=<paste from console>
MICROSOFT_CLIENT_SECRET=<paste from console>
MICROSOFT_TENANT=organizations
```

Rules:

- `OAUTH_ENV` is `development` or `production`. The plan's boot check refuses to start when `PUBLIC_URL` is not `localhost` and the setting says development, or the reverse. This keeps the dev client away from real customers and the prod client off a laptop. It is added in P1, so setting it before then has no effect.
- `GOOGLE_PICKER_API_KEY` and `GOOGLE_PROJECT_NUMBER` are public values (they reach the browser). Whether the Picker needs both is unverified (plan 5.1, unverified list item 3). Collect both anyway.
- A provider with no client configured keeps its current paste form. A server with none of these set behaves exactly as today.
- Secrets: env only. Not in the database, not in git, not in `docker-compose.yml`, not in a log. `.env` is already outside git. Do not paste values into a PR or chat.
- Never reuse a dev value in prod. Use separate `.env` files.

## 4. Redirect URIs

Every provider uses one kymavo callback, built from `PUBLIC_URL`:

| Environment | Redirect URI |
|---|---|
| Dev | `http://localhost:3000/settings/connections/oauth/callback` |
| Prod | `https://<production host>/settings/connections/oauth/callback` |

Microsoft also keeps the existing Outlook callback registered, so Outlook keeps working until its phase lands (plan 5.1):

| Environment | Existing Outlook redirect URI (keep) |
|---|---|
| Dev | `http://localhost:3000/settings/connections/outlook/callback` |
| Prod | `https://<production host>/settings/connections/outlook/callback` |

Register the new URI in addition to the old one, never instead of it. Redirect URIs must match exactly, including scheme, host, port and path. Whether a provider accepts `http://localhost` is provider specific, check the console, this may have changed.

## 5. Google

Goal: two Cloud projects, one OAuth client each, and a verified production consent screen. Documentation: [OAuth app verification help](https://support.google.com/cloud/answer/13463073), [OAuth for web server apps](https://developers.google.com/identity/protocols/oauth2/web-server), [Manage app audience](https://support.google.com/cloud/answer/15549945), [Picker overview](https://developers.google.com/workspace/drive/picker/guides/overview).

### 5.1 Dev project (`daloy-dev`)

1. Create a Cloud project named `daloy-dev`. Whether this needs a billing account is unverified.
2. Enable the APIs the phases need: Drive, Sheets, Calendar, Gmail and the Picker. Enable only what the phase you are testing needs if you prefer. Check the console, this may have changed.
3. Configure the consent screen as External and leave it in Testing. In Testing you can list up to 100 test users and refresh tokens last seven days (confirmed). Add your own accounts as test users.
4. Add the scopes the plan lists for each phase on the consent screen's data access page. Do not add any restricted scope. The scopes are in plan section 8: `openid`, `email`, `profile` and `drive.file` for Sheets and Drive, `gmail.send` for Gmail, and a Calendar scope to be settled (below).
5. Create an OAuth client for a web application with the dev redirect URI from section 4.
6. Copy the client id and secret into the dev `.env` as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. Type them yourself.
7. For the Picker, create a browser API key and restrict it by HTTP referrer to `http://localhost:3000/*`. Copy the project number from the project's settings. Put them in `GOOGLE_PICKER_API_KEY` and `GOOGLE_PROJECT_NUMBER`. Whether the Picker needs both is unverified.

Calendar scope: plan 6.2 says to check the consent screen's data access page before choosing, because sources disagree on whether `calendar.events` is sensitive or restricted (unverified). If a Calendar scope shows as restricted, do not request it and tell the P6 session.

### 5.2 Prod project (`daloy-prod`)

1. Create a second Cloud project named `daloy-prod`.
2. Configure the consent screen as External with the app name, support email, logo, homepage, privacy policy and terms links from section 2.
3. Add your domain as an authorized domain and verify it with Google Search Console (free, plan 8 step 2). Whether a `pages.dev` subdomain can be verified is unverified and probably not.
4. Request brand verification. It takes 2 to 3 business days (confirmed).
5. Create an OAuth client with the prod redirect URI from section 4. Copy id and secret into the prod `.env`.
6. Create a browser API key restricted by referrer to `https://<production host>/*`. Copy the project number.
7. Do not publish to In production until P2 runs on a staging host with this client (plan 8 step 4). With only non-sensitive scopes, Sheets and Drive can go to customers while later scopes wait. Whether an app with only non-sensitive scopes still shows an unverified warning or the 100 user cap is unverified, check the console, this may have changed.

### 5.3 Google verification submission checklist (sensitive scopes)

Matches plan section 8. Do this after P5 (Gmail) and P6 (Calendar) run on staging with the prod client. Gmail and Calendar go to customers only after approval, because an unverified app requesting sensitive scopes is capped at 100 users (confirmed).

- [ ] Domain verified in Search Console and set as the authorized domain.
- [ ] Brand verification approved.
- [ ] Homepage, privacy policy and terms live, accurate, and linked on the consent screen. The homepage explains each Google feature.
- [ ] Scopes on the consent screen match the in-code manifest exactly. No restricted scope. A new scope later needs approval before it can be called (confirmed).
- [ ] A written justification for each sensitive scope: `gmail.send` (sensitive, confirmed), and the Calendar scope the console shows (tier unverified).
- [ ] A demo video showing the consent screen and each feature using the scope. The video requirement is from memory, unverified: read the current requirements in the console.
- [ ] The staging host and the prod client are the ones shown in the video.
- [ ] Submit. Sensitive scope review is up to 10 business days (confirmed). Plan for one round of questions that adds a week or more (unverified).
- [ ] Answer Google's questions from the support email you listed.
- [ ] On approval, publish the consent screen and enable the Gmail and Calendar buttons for customers.
- [ ] Record the approval date and scopes here and in the P8 pack.

Restricted scopes are not part of this checklist. They need a paid assessment every 12 months, and the plan avoids them.

## 6. Slack

Goal: one Slack app per environment with bot scopes `chat:write` and `channels:read` (confirmed) and your kymavo redirect URI. Documentation: [Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/), [Token rotation](https://docs.slack.dev/authentication/using-token-rotation/).

1. Create a Slack app for dev and another for prod, in a workspace you control.
2. Add the redirect URI from section 4.
3. Add the bot scopes `chat:write` and `channels:read`. `chat:write.public` would let kymavo post without being invited, but that is unverified. Leave it out unless the P3 session decides otherwise.
4. Leave token rotation off. Tokens do not expire without it, and with it they last 12 hours and each refresh token is single use (confirmed).
5. Enable public distribution for the prod app so any workspace can install it (check the console, this may have changed). Do not submit to the Marketplace. Whether a non-Marketplace app can be installed by any workspace without review is unverified.
6. Fill in the app's privacy policy and support details with the pages from section 2 if the console asks (check the console, this may have changed).
7. Copy the client id and secret into `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`.
8. Read Slack's commercial distribution terms before charging for the app (plan section 9, item 4). Slack's terms point commercial distribution to the Marketplace (confirmed from a summary), and the Marketplace needs at least five active installs (confirmed from a summary).

Slack OAuth PKCE support is unverified. The P3 session checks it.

## 7. Microsoft Entra (Outlook)

Goal: keep the existing registration, add the new redirect URI, and add publisher verification. Documentation: [Publisher verification overview](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview), [Mark an app as publisher verified](https://learn.microsoft.com/en-us/entra/identity-platform/mark-app-as-publisher-verified). The existing first-time setup is in `docs/live-microsoft-check.md`.

1. Keep the existing app registration and its `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`. Do not create a new app. Use one registration per environment.
2. Keep the permissions `Mail.Send`, `User.Read` and `offline_access` (delegated). They do not change.
3. Add the new redirect URI from section 4 as an additional Web redirect. Keep the existing Outlook one.
4. Client secrets expire in Entra. Put the expiry date in a calendar and create the next secret before it ends. The maximum lifetime is unverified.
5. Publisher verification (free, confirmed). It cuts administrator prompts in other tenants. How an unverified publisher affects consent in other tenants is unverified. Requirements (confirmed, plan 4):
   - A Microsoft AI Cloud Partner Program (Partner Center) global account that has finished verification. This needs the business verified. It is paperwork, not money.
   - The app registered in a work or school tenant.
   - A publisher domain that is not `onmicrosoft.com` and matches the partner email domain. This uses your domain from section 1.
   - The person doing it is an Application Administrator and Partner admin, signing in with MFA.
6. Set the publisher domain on the app and associate the partner account id, then check the app shows as verified. Exact menus: check the console, this may have changed.
7. Personal Microsoft accounts stay out (`MICROSOFT_TENANT=organizations`, plan question 9).

Teams stays a guided paste. Nothing to register.

## 8. Airtable

Goal: an OAuth integration with the scopes `data.records:write` and `schema.bases:read`, plus `data.records:read` only if the P4 session keeps reading a record (plan section 3). Documentation: [OAuth integrations](https://airtable.com/developers/web/guides/oauth-integrations), [Builder Hub](https://support.airtable.com/articles/9362950318-using-builder-hub-in-airtable).

1. Register an OAuth integration for dev and another for prod. Registering is free.
2. Add the redirect URI from section 4 and the scopes above.
3. Airtable requires a privacy policy URL, terms URL and support email before other users can authorize (confirmed). Use the pages from section 2 and the support address from section 1. A review step was not found (unverified).
4. Copy the client id and secret into `AIRTABLE_CLIENT_ID` and `AIRTABLE_CLIENT_SECRET`.

PKCE requirement and access token lifetime are unverified. Refresh tokens are invalidated after 60 days of inactivity and revoked if reused after rotation (confirmed), which is why kymavo runs a keepalive sweep.

## 9. Notion

Goal: a public integration with the capabilities the P4 session lists (read and insert content). Documentation: [Authorization](https://developers.notion.com/guides/get-started/authorization), [Public connections](https://developers.notion.com/guides/get-started/public-connections).

1. Create a public integration for dev and another for prod.
2. Add the redirect URI from section 4. Set the capabilities to the minimum (read content, insert content).
3. Fill in the company, privacy policy and terms fields with the pages from section 2 if the form asks (check the console, this may have changed).
4. Copy the client id and secret into `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET`.

No review is needed to use a public integration. A security review is only for the Marketplace (confirmed). The consent screen has a page picker (confirmed). Whether ordinary tokens expire and rotate, whether a non-admin member can authorize, and the revoke endpoint are unverified.

## 10. Trello

Goal: a Trello OAuth 2.0 (three-legged) app with a confidential client. Documentation: [OAuth 2.0 now available](https://community.developer.atlassian.com/t/oauth-2-0-3lo-is-now-available-for-trello/102691), [Authorizing with Trello's REST API](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/), [OAuth 2.0 confidential client usage](https://developer.atlassian.com/cloud/trello/guides/rest-api/oauth-2-confidential-client-usage/).

1. Find where a Trello OAuth 2.0 app is registered and create one for dev and one for prod. Where it is registered, and whether it needs approval or a fee, are unverified (plan unverified list item 14). Read the documentation first and tell the P4 session what you find.
2. Add the redirect URI from section 4.
3. The scopes are `read`, `write` and `offline_access` (confirmed). `offline_access` is needed to get a refresh token. Access tokens last one hour and refresh tokens 90 days and rotate (confirmed).
4. Copy the client id and secret into `TRELLO_CLIENT_ID` and `TRELLO_CLIENT_SECRET`.

## 11. Where each secret goes

| Value | Goes in | Never in |
|---|---|---|
| Client secrets (Google, Slack, Airtable, Notion, Trello, Microsoft) | Server `.env`, per environment | Database, git, compose file, logs, chat, screenshots |
| Client ids | Server `.env` (not secret, but keep them with the secret) | Database |
| Google Picker API key and project number | Server `.env` (public values, the browser receives them) | Git |
| Customers' access and refresh tokens | Encrypted `connections` row with `SECRETS_KEY` (written by kymavo, not by you) | `.env`, logs |
| Expiry dates of client secrets | Your calendar | Git |

## 12. Finish checklist

- [ ] Domain bought and verified in Google Search Console.
- [ ] Homepage, privacy policy and terms live and linked.
- [ ] Support email set up.
- [ ] `daloy-dev` Google project, Testing, test users, client, Picker key and project number in the dev `.env`.
- [ ] `daloy-prod` Google project, consent screen, authorized domain, brand verification requested.
- [ ] Slack dev and prod apps, secrets in `.env`.
- [ ] Entra: new redirect URI added beside the Outlook one, publisher verification started, secret expiry noted.
- [ ] Airtable, Notion and Trello dev and prod apps, secrets in `.env`.
- [ ] `OAUTH_ENV` set in each environment.
- [ ] Redirect URIs match `PUBLIC_URL` exactly in every console.
- [ ] No secret in git, the database or chat.
- [ ] Unverified items from plan section 15 that affect P0 (items 1, 8, 9) answered, and the answers recorded below.

## Results

None recorded yet.
