# 0118: Menu buttons on Messenger, Instagram and email

## Context

C2 of the resort concierge plan (`docs/plans/resort-concierge.md`, section (b)). Guests ask the same four or five things (rooms, rates, location, activities), and typing a question costs an AI action and a few seconds. Meta lets a reply carry tap buttons (quick replies, at most 13, title at most 20 characters) and sends a tap back as a signed webhook event. Until now `meta_reply` sent text only and the webhook parser dropped quick-reply payloads and postbacks. Email has no buttons.

## Options

1. Let the owner type any payload and pass it through to the run. Rejected: a payload is whatever the event says, so anyone who can send the Page a message could put any word in `{{trigger.choice}}`. A fixed list keeps every branch on a known value.
2. A fixed list of choice ids, owner-written titles. Chosen. The ids are the plan's list: `rooms`, `rates`, `location`, `activities`, `book`, `staff`.
3. For email, remember on the conversation which menu was last sent and number against that. Rejected for now: it needs a column and a write per reply. The numbers follow the workflow's email menu instead, and save refuses a workflow whose email menus disagree.

## Decision

- `meta_reply` gains `quickReplies: [{ title, choice }]`: 1 to 13 buttons, titles 1 to 20 characters after trimming, `choice` from the fixed list. Two buttons may share a choice (an English and a Tagalog label). Meta gets `quick_replies` with `content_type: "text"` and the choice as the payload. Save refuses anything else.
- The signed webhook (signature checked first, as before) reads `message.quick_reply.payload` and `postback.payload`. A payload that is not one of the fixed ids is dropped: a quick reply then arrives as plain text with no choice, and a postback, which has no text of its own, is dropped whole. A postback without a `mid` is dropped, since there is nothing to deduplicate a replay by.
- Per workflow, the accepted choices are those some menu of its published version offers. A known choice the workflow does not offer is treated like an unknown one. An accepted tap sets `{{trigger.choice}}`; a postback's button title becomes `{{trigger.text}}`.
- A tap is a message like any other: it joins the guest's conversation (decision 0115), and its `mid` keys the run, so one tap starts one run and a replayed tap starts none.
- `email` and `outlook` steps gain `menu`, written under the message as `1. Rooms`, `2. Rates`. Email-in reads a reply whose first non-empty line is only a number (`2` or `2.`) as that line of the workflow's email menu and sets `{{trigger.choice}}`. Every email menu in one workflow must list the same choices in the same order.
- The console's step form does not draw list fields yet. A menu set by a template or the API is kept as saved when the other fields are edited.

## Consequences

- A tapped button can route through a condition on `{{trigger.choice}}` to a fixed answer with no AI call, as the concierge template (C8) will do.
- New choice ids need a code change. The list covers the pilot's menu; a free-text menu would need the trust rules above to be thought through again.
- Not done: the Get Started button and the persistent menu (the plan's stretch goal). The resort can set both in Meta Business Suite; a postback they send counts only if its payload is one of the choice ids. Instagram quick-reply limits and the postback `mid` are taken from Meta's documentation and are unverified until the live Meta check.
- A guest who writes "2" as the first line of a longer email ("2\nand also, do you allow pets?") gets choice 2 and the rest is still in `{{trigger.text}}`.
