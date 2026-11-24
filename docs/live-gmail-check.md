# Manual live Gmail check

The automated tests never contact Google. They use a fake SMTP server (`test/fake-smtp.ts`) that accepts a login, records which account sent each message, and answers a listed password with Gmail's 535 rejection. This page is the separate check against a real Gmail account. Run it by hand with an account you control.

Status: run on 15 November 2026 at commit 9df014d (N2a). Results are at the end of this file. Record any later run there too.

## Before you start

- A Gmail account with 2-Step Verification turned on, and an app password created for it ([Google's instructions](https://support.google.com/accounts/answer/185833)).
- kymavo running with `docker compose up` and seeded. `PUBLIC_URL` must be the address you open the console on, or the confirmation link points somewhere else.
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
9. With two kymavo accounts each connected to a different Gmail account, send one inquiry to each form and check that each reply comes from its own owner's address.

## Booking reminder check (N2a)

Run this after step 5, while Gmail works. Publish a workflow whose form has an email field, a resource field and a datetime field (`slotMinutes: 5`). Its steps: `booking` (create), an email confirmation to the guest, a `delay` until the booking start with `offsetSeconds: -600`, and an email reminder. Book a few slots 20 to 40 minutes ahead, then on the Bookings page leave one, cancel one and reschedule one before their reminders wake. Count "confirmation" and "reminder" subjects in the Gmail Sent folder and compare them with the run history. Then revoke the app password, book one more slot, and check that its reminder fails and that nothing reaches the installation's own mail server (Mailpit).

## Results

### 15 November 2026, commit 9df014d (N2a)

Setup: a disposable Compose project (`daloy-n2a`, host ports 53000, 55432, 51025 and 58025, a throwaway `SECRETS_KEY`, its own volume), built from 9df014d and removed afterwards. The development stack was not touched. Two throwaway kymavo owners. Two real Gmail accounts with app passwords and one other inbox as the customer and guest, all owned by the person running the check. They typed every address and app password themselves; none is recorded here.

1. Pass. Business name, inquiry inbox and reply address saved.
2. Pass. Status read "Waiting for you to confirm the test email".
3. Pass. Google accepted the test email. It arrived from the Gmail address with the business name as the sender name.
4. Pass. The link showed "Confirmed", then the "used already" message on the second open.
5. Pass. The customer got the reply from the Gmail address, the inquiry inbox got the notification, and Reply on the customer's copy addressed the reply address from step 1.
6. Pass, with a wording difference. After the app password was deleted in Google, the next inquiry failed with "Gmail rejected the app password", the status read "Google rejected the app password", and the page said mail is paused. The booking reminder that woke afterwards failed with "Gmail could not send. Reconnect Gmail in Settings, Business and email." That is the designed behaviour (`packages/db/src/mail-senders.ts`): the first rejected send pauses the sender, and later sends are refused without contacting Google. Nothing reached Mailpit (0 messages for the whole check).
7. Pass. A new app password through Replace password and a test email returned the status to "Sending from this address".
8. Pass. After Disconnect, an inquiry failed with "Gmail is disconnected. Reconnect Gmail in Settings, Business and email." and nothing was sent. (Run before step 6 in this session; the order does not affect the result.)
9. Pass. With two owners on two Gmail accounts, one inquiry to each form: each notification and customer reply came from its own owner's address and business name.

Booking reminder check, Room 1, Asia/Manila, times are booking starts:

| Booking | What happened | Confirmation | Reminder |
| --- | --- | --- | --- |
| 12:30 | left alone | sent | sent at 12:20 |
| 12:15 | booked at 12:11, reminder time already passed | sent | none: the delay took `late` and the run ended |
| 12:35 | rescheduled to 12:55 on the Bookings page | sent, then a new one for 12:55 | old run stopped as cancelled at 12:25; new run sent at 12:45 |
| 12:45 | cancelled | sent | none: the run woke at 12:35 and stopped as cancelled |
| 13:05 | booked before the revoke took effect | sent | sent at 12:55 |
| 13:20 | app password revoked after booking | sent | failed at 13:10, nothing sent |

Run history: 7 confirmation sends and 3 reminder sends succeeded, 1 reminder failed. The Gmail Sent folder held the same: 7 confirmations and 3 reminders (12:30, 12:55 and 13:05), and the guest inbox received the same 10 messages. No reminder went to the cancelled booking.

Findings, not fixed in N2a:
- The Cancel button on the Bookings page uses the browser's native confirm dialog. The Claude desktop browser pane did not show it, so the click did nothing there; the 12:45 cancel was made with the same `POST /bookings/:id/cancel` call the button makes. An in-page confirmation would work in every browser.
- A business name that ends in a full stop gives two full stops ("Ltd..") in the inquiry reply, which writes the name followed by a full stop.
- The baseline expected the reminder after a revoke to say "Gmail rejected the app password". Only the first send after the revoke says that; see step 6.
