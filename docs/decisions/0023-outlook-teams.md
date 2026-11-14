# 0023: Outlook through Microsoft consent, Teams through a Workflows link, and a purchase request template

## Context

Roadmap phase 5 adds Microsoft offices: send email from the office's own Outlook mailbox, post a notification to a chosen Teams channel, and a template a pilot office can use, purchase request intake with a named approver. Organization policy may require an administrator, and Daloy has to say so before the owner leaves for Microsoft's pages. A Teams post must not count as an approval. The acceptance check asks for administrator-denied consent, reconnection and delivery status, and for a request that a client can follow from the form to its destination without the editor.

Daloy has to keep running locally with free software and no paid account, and the tests may not talk to Microsoft. No Microsoft account was available while building this.

## Options

How the owner connects Outlook:

1. An app password over SMTP, like Gmail in [decision 0020](0020-owner-mail-senders.md). Microsoft 365 turns SMTP basic authentication off by default and is retiring it, so most offices could not use it.
2. OAuth authorization code with PKCE against an Entra app registered by whoever runs the installation, with the delegated permissions `Mail.Send`, `User.Read` and `offline_access`, and Graph `sendMail`.
3. The device code flow. No redirect address is needed, but many organizations block it with Conditional Access because it is used for phishing.

How Teams gets a message:

1. A Teams bot or Graph `ChannelMessage.Send`. Needs a bot registration, or application permissions that Microsoft only grants for migrations.
2. An Office 365 connector incoming webhook. Microsoft is retiring these.
3. A Teams Workflows flow from the template "Post to a channel when a webhook request is received". The owner picks the team and channel in Teams and pastes the link it shows.

How the template sends its email:

1. As ordinary email steps run inside the run, like the office request receipt.
2. As `outlook` deliveries when the owner ties the template to Outlook, with the same queue as Sheets and Slack ([decision 0021](0021-sheets-slack-deliveries.md)).

## Decision

- Outlook option 2. The installation sets `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` (an Entra app registration is free), and optionally `MICROSOFT_TENANT` (default `organizations`). Without them the Outlook panel says Outlook is not set up and nothing else changes.
- Consent is stateless. `POST /settings/connections/outlook/start` signs `{workspace, member, expiry (10 minutes), nonce}` with an HMAC of the secrets key and derives the PKCE verifier from the same key and state, so nothing is stored between the two requests. The callback is outside the session guard so an administrator without a Daloy account can return there after approving, but it only swaps a code for tokens when the signed-in member is the owner who started, in the same workspace, before the expiry.
- The callback sends the browser to `#/settings/business/outlook-<outcome>` with one of `connected`, `admin_required`, `declined`, `expired`, `failed` or `admin_approved`. Microsoft's own text never reaches the page. `access_denied` is ambiguous at Microsoft (a person saying no and a tenant that blocks user consent both use it), so the AADSTS code in the description decides: 90094, 90095, 900941, 65002 or the word admin mean an administrator must approve.
- The Outlook panel lists the permissions and says an administrator may have to approve, with the admin consent link, before the Connect button. The admin consent page returns to the same callback with `admin_consent=True`.
- The refresh token is the stored credential, encrypted per owner like every other connection. Microsoft hands back a new one on each refresh, and Daloy stores it (`updateCredential`). Access tokens are cached in memory for their hour. A Graph 401 signs in once more; `invalid_grant`, `interaction_required` or a new administrator requirement marks the connection failed with "Reconnect Outlook". A 403 or `MailboxNotEnabledForRESTAPI` fails the delivery without touching the connection. 429 and 503 back off, honouring `Retry-After`.
- `sendMail` answers 202 with no message id, and reading Sent Items would need `Mail.Read`. So a send that timed out or got a 5xx goes to `needs_review` with "Look in Sent Items", and the operator chooses Mark as sent or Send again, the same as Slack.
- Teams option 3. The workflow link is the credential (anyone holding it can post), so it is encrypted and never returned. It must be https on a host ending in `logic.azure.com` or `powerplatform.com` (`TEAMS_WEBHOOK_HOSTS`); tests add 127.0.0.1, the only host allowed over plain http. The owner types the channel's name, which is only shown in Daloy. 202 means Workflows accepted the card; it posts a moment later, so the result says "accepted by Teams". 404 means the flow was deleted or turned off and marks the connection failed. 401 or 403 means the trigger only accepts signed-in callers, which is a policy choice to change in Teams.
- The Teams card carries the reference and the item only, plus "Decisions are made in Daloy by the named approver". It has no buttons.
- Template option 2 when Outlook is chosen. `purchase-request` asks for name, email, item, estimated cost and reason; sends a receipt; asks the named approver ([decision 0022](0022-workspace-members-named-approvals.md)); on approval emails purchasing, optionally posts to Teams, and tells the employee; on rejection or after a week without a decision tells the employee. Outlook and Teams are opt-in, so the local demo runs on Mailpit. Turning on is refused until the chosen connections work and the approver may approve.
- The approval request itself stays an approval step and goes through the Business and email sender. It carries the single-use link and has its own retry rules; moving it into a delivery would change how approvals work for every workflow.
- Guided setup is shared with the office request: `setup.template` is now `office-request` or `purchase-request`, and a saved setup without a template is still an office request.

Credential revisions (after Astra's review of 283fa1a): a rotated refresh token is written only while the connection still holds the credential it was rotated from (`updateCredential` with the revision, the stored ciphertext's IV). A send or console test follows its own rotation (`rotateInto`), so its success or refusal is recorded against the new revision. A refresh answer held across a Reconnect can no longer put the old mailbox's token under the new mailbox.

## Consequences

- Each installation that wants Outlook registers its own Entra app with the redirect address `<PUBLIC_URL>/settings/connections/outlook/callback`. That is a step for whoever runs Daloy, documented in the README.
- An organization that blocks user consent needs its administrator once. Until then the owner sees why and has the link to send.
- Outlook mail and Teams notes have the same delivery states, Retry, and review choices as Sheets and Slack. A Teams failure inside the flow after the 202 is only visible in the flow's run history in Teams.
- One Outlook mailbox and one Teams channel per owner.
- Live behaviour is unverified. The tests use `test/fake-providers.ts`, which follows Microsoft's documented answers (consent errors, PKCE, rotating refresh tokens, 202 with no body, Workflows 404). The manual steps are in [live Microsoft check](../live-microsoft-check.md).
