# Manual live Discord and Google Docs check

The automated tests never contact Discord or Google. They use the fake Discord, Drive and Docs servers in `test/fake-providers.ts`. This page is the separate check against real accounts. Run it by hand with accounts you control.

Status: not run yet. Record the date, the kymavo commit and what you saw under Results when you do.

## Before you start

- A Discord server where you can manage a test channel, and the Manage Webhooks permission on that channel.
- For Google Docs: Google Drive connected with Google (see [live Google OAuth check](live-google-oauth-check.md)), a Drive folder picked in Apps, the Google Docs API turned on in the Google Cloud project, and a Google Docs template containing `{{name}}` and `{{amount}}`.
- kymavo running and seeded.

## Discord

1. In the channel's settings choose Integrations, Webhooks, make a webhook and copy its URL. Menu names may differ.
2. In Apps, open Discord, paste the link and a channel name, and select Connect Discord. Expect a test message in the channel, and the card to show the channel name and never the link.
3. Paste `https://example.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz` and expect a refusal that names the Discord address.
4. Make a workflow with a Post to Discord step and the text `New request {{trigger.reference}} @everyone`. Run it. Expect the message and no ping.
5. Send a text of more than 2000 characters. Expect the step to fail with the length message and nothing in the channel.
6. Delete the webhook in Discord and run again. Expect "The Discord webhook was deleted" and the connection marked as needing a new link. Paste a new link and select Retry. Expect one message.
7. Look in the run history, the Requests list and the answer of `GET /settings/connections`. Expect no webhook link anywhere.
8. To see a rate limit, start many runs at once. Expect kymavo to wait and then post each message once.

## Google Docs

1. Add a Make a document step. Select Pick a template and choose the template in the Google Picker. Expect its name to show. Only Google Docs documents should be offered.
2. Set the name `Invoice {{trigger.reference}}` and the values `name` and `amount`. Run the workflow. Expect one new document in the folder, named from the step, with the placeholders replaced, and the step output holding its link.
3. Make one value contain `{{amount}}`. Expect it typed in the document as is, not replaced.
4. Add a value for a placeholder the template does not contain. Expect it listed as unmatched in the step output and no failure.
5. Send a template id that you did not pick in the Picker to `POST /settings/connections/google-drive/template`. Expect a refusal asking to pick the template again.
6. Turn off the Google Docs API in the project and run. Expect a message that names the API and the person who runs kymavo. Turn it on and select Retry.
7. Retry a step that failed after the copy. Expect no second copy in the folder.
8. Connect Google Drive with a service account key instead. Expect Make a document to be refused when turning the workflow on.

## Results

None recorded yet.
