# Getting permission to show app logos

The Apps page (`apps/web/src/Apps.tsx`) shows a letter tile and the app's name for Gmail, Google Sheets, Slack, Outlook and Microsoft Teams. All three companies allow their product names in plain text ("Works with Microsoft Teams"). Their logos need written permission first. This page lists how to ask, as found on their official sites on 17 November 2026. It is not legal advice, and items marked unconfirmed were not on the pages read.

## Before asking anyone

- Have a company name, a public website and a contact address. Each request asks who you are and where the logo will appear.
- Take a screenshot of the Apps page with the letter tiles, and write one sentence on the use: "Shown on an Apps card next to a Connect button, at 32 px, to show that Daloy can send through your product. We do not change the logo or suggest you endorse Daloy."
- Keep every reply in writing. Save it in `docs/decisions/` before any logo goes into the repo.

## Google (Gmail, Google Sheets)

1. Apply for a Partner Marketing Hub account: https://partnermarketinghub.withgoogle.com/signup/
2. Once signed in, request permission through the asset approval form: https://partnermarketinghub.withgoogle.com/submit-assets/ . Google's rule for product icons is on https://partnermarketinghub.withgoogle.com/brands/google/branding-guidelines/how-to-show-googles-brand/
3. Wait for approval, then download the icons from the hub itself, not from other sites.

Google asks partners to use product icons only when necessary and allows plain "integrates with" text without asking. The Sign in with Google guidelines cover sign-in buttons only, not Connect cards. Fee, timeline, and whether an app without a public listing qualifies: unconfirmed. Using Gmail through OAuth (planned) would also need Google's OAuth app verification, which is separate from logo permission.

## Slack

1. Read the brand terms: https://slack.com/terms-of-service/slack-brand . They say most uses need a specific written licence and list "Don't use the Slack logo" among the rules.
2. Ask for a licence through Slack's help centre (https://slack.com/help/contact), describing the use above.
3. Optional, and slower: build a Slack app and list it in the Slack Marketplace. That starts a Slack security review and lets you say "integrated with Slack", but the Marketplace agreement (https://slack.com/terms-of-service/slack-marketplace) gives no right to the logo by itself.

Daloy connects to Slack with a bot token today, not a listed Slack app. Fee and whether an unlisted app can get a logo licence: unconfirmed; assume no until Slack says otherwise.

## Microsoft (Outlook, Teams)

1. Read the trademark guidelines: https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general . Logos and app icons "can never be used without an express license".
2. Email trademarks@microsoft.com with the use described above and the screenshot. Partners doing joint marketing use the form at https://aka.ms/partnerled-marketing-attestation (not read).
3. Publishing a Teams app (Partner Center account, publisher verification, validation: https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/appsource/publish) and joining the Microsoft AI Cloud Partner Program did not show any grant of icon use.

The Azure and Microsoft 365 architecture icon sets are for diagrams, training and documentation only, so they do not cover an Apps card. Fee: unconfirmed.

## When permission arrives

1. Save the written permission and its conditions in a decision record.
2. Put the file the company sent (unchanged) in `apps/web/public/apps/`, with a line in `apps/web/public/apps/SOURCES.md` naming its source, the permission and the date.
3. In `Apps.tsx`, show that file instead of the letter tile for that app only, at the size and clear space the permission sets, never recoloured.
