# 0115: Conversation state for Messenger, Instagram and email guests

## Context

C1 of the resort concierge plan (`docs/plans/resort-concierge.md`). Until now every guest message was its own run with no memory: a follow-up could not see what the guest said before, a newer message did not cancel an older run's follow-up, the 24-hour window was measured from the message that started the run, and a staff reply from the Page inbox did nothing to stop the bot. The DM path also showed no privacy notice, and R6 export and delete could not see a guest who only ever wrote on Messenger.

## Options

1. Debounce: hold every message a few seconds and answer only the last. Rejected: it slows every reply and still answers twice when a message comes after the delay.
2. Order runs of one conversation the way booking versions order runs of one booking (decision 0032): each inbound message raises a version, and a run of an older version stops at its next step. Two messages a second apart give one reply when the run has any step before its reply (an AI step takes seconds); a reply that already went out stays sent.
3. Recognise Daloy's own echo by the Meta app id on the echo. Rejected for now: the connection stores no app id, and asking for it adds a Graph call at connect time. Instead every reply carries `metadata: "daloy"`, which Messenger returns on the echo, and an echo with the same text as a reply queued in the last ten minutes also counts as Daloy's own, in case Instagram drops the metadata (unverified).
4. Keep message text forever with the run history. Rejected: RA 10173 asks for a retention period, and the owner chose 90 days.

## Decision

- Tables `conversations` (one per workspace, channel and guest id: PSID, Instagram-scoped id or lowercased reply address; status `bot`, `staff` or `closed`; version; saved fields; last inbound and outbound times; `staff_until`; `notice_sent_at`) and `conversation_messages` (direction `in`, `out` or `staff`, text up to 4,000 characters, `mid` unique per conversation). `runs.conversation_id` and `runs.conversation_version`. Workspace settings on `users`: `conversation_retention_days` (default 90, 1 to 3,650) and `staff_quiet_hours` (default 12, 1 to 168). Migration 0049.
- The Meta webhook records the message and creates every run that answers it in one transaction, with the conversation row locked. A replayed `mid` adds no message, raises no version and starts no run. Email-in does the same in its batch transaction, keyed by the lowercased reply address, deduplicated by Message-ID or else the mailbox position. A message that no workflow listens to is not recorded.
- The trigger payload gains `conversation`: id, status, fields and the last 10 messages, oldest first, within 4,000 characters.
- `runSuperseded` replaces `bookingSuperseded` wherever a run may stop: before each step, under the share lock right before an unsafe send, after a failed attempt, and before a queued delivery is sent. A run of an older conversation version is cancelled with "The customer sent a newer message".
- `meta_reply` checks the run's conversation before it queues anything. Staff have it (`status = staff` and `staff_until` in the future): branch `paused`. More than 24 hours since `last_inbound_at`: branch `outside_window`. Each may have its own edge, like a delay's `late`. Without a `paused` edge the run ends quietly; without an `outside_window` edge the step fails with the window message. The delivery's window check uses the same `last_inbound_at`.
- Echoes: Daloy's own echo changes nothing. Any other echo is a person replying from the inbox: it is stored as a `staff` message, and the conversation goes to `staff` until now plus the quiet period. The next guest message after that time returns it to `bot`. Take over and Hand back buttons are C7.
- The first reply of a conversation carries a fixed notice in the workspace language: an automated assistant, what is kept and for how many days, that messages go to the AI provider, and not to send IDs, card numbers or health details. `notice_sent_at` is claimed in the transaction that queues the reply, so it goes once. If notice and reply together pass 2,000 characters, the reply goes alone and the next one carries it.
- Step `conversation_update` saves a fixed list of fields (`check_in`, `check_out`, `guests`, `name`, `phone`, `email`), each trimmed to 200 characters; an empty value keeps the saved one. Only a `meta_dm` or `email` trigger may use it.
- Retention: the worker sweep deletes conversations whose last message is older than the workspace's days, with their messages, and erases the runs that answered them as a customer delete does (their payload carries the history).
- R6: `collect()` finds conversations by saved fields, the email address one is keyed by, any message text, or a matched run, and adds every run of those conversations. Export lists conversations and messages. Delete removes them outright, so `keptOf()` lists nothing for them.

## Consequences

- A burst of messages gives one answer to the latest state, and a newer message cancels a waiting follow-up for free.
- A workflow that sends a reply as its very first step can still answer two quick messages twice; the plan's concierge template has an AI step first.
- A staff reply from the inbox stops the bot for 12 hours by default. If Meta changed the echo format or dropped our metadata on both channels, Daloy's own reply would be stored once as an `out` row and the text match would still hold; the live Meta check confirms both.
- Not done here: the privacy notice has no link to the resort's privacy page (there is no field for one yet), the notice is not added to email replies (C6 threads email replies), conversations of test runs do not exist because builder runs never come from the webhook, and `open_due_id` waits for C6.
