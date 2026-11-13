# Manual live Gmail check

The automated tests never contact Google. They use a fake SMTP server (`test/fake-smtp.ts`) that accepts a login, records which account sent each message, and answers a listed password with Gmail's 535 rejection. This page is the separate check against a real Gmail account. Run it by hand with an account you control.

Status: not run yet. Record the date, the Daloy commit and what you saw at the end of this file when you do.

## Before you start

- A Gmail account with 2-Step Verification turned on, and an app password created for it ([Google's instructions](https://support.google.com/accounts/answer/185833)).
- Daloy running with `docker compose up` and seeded. `PUBLIC_URL` must be the address you open the console on, or the confirmation link points somewhere else.
- A second account to receive mail, so you can see a customer's copy.

## Steps

1. Sign in, open Business and email, and save a business name, an inbox for new inquiries (your second account) and a reply address.
2. Connect Gmail with the address and app password. The status reads "Waiting for you to confirm the test email".
3. Select Send a test email to me. Expect "Google accepted a test email". Check that the email reached the Gmail inbox, sent from your address with your business name.
4. Open the link in that email in the browser where you are signed in. Expect "Confirmed". Open it again: expect the "used already" message.
5. Select Turn on inquiry replies, open the form link, and send an inquiry with your second account as the customer address. Expect the reply in that inbox from your Gmail address, and the notification in the inquiry inbox. Answering the reply should address the reply address from step 1.
6. Revoke the app password in your Google account. Send another inquiry. Expect the run to fail with "Gmail rejected the app password", the status to read "Google rejected the app password", and no email from any other address.
7. Create a new app password, select Replace password, then Send a test email to me. The status returns to "Sending from this address".
8. Select Disconnect. Send an inquiry: expect a failed run saying Gmail is disconnected, and no email.
9. With two Daloy accounts each connected to a different Gmail account, send one inquiry to each form and check that each reply comes from its own owner's address.

## Results

None recorded yet.
