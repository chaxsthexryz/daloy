# 0048: Build with AI is a conversation

## Context

Build with AI asked four questions the page wrote itself ("What starts it?", "Who should know?", "Where should it go?", "Does someone approve it first?") and then sent one request to the model. That kept the cost at one call, worked with no model at all and could not ask a useless question, but it also could not ask about anything it did not already list. An owner who wanted "when a purchase over 10,000 is requested, ask my accountant" had no way to say so except in the description, and an owner who did not understand the four terms had no way to ask back. The page said so on screen: "Question 1 of 4. The page asks these, not a model."

## Options

1. Keep the fixed questions and add a free-text box for anything else. The model still cannot ask, so the gaps it finds stay unfilled.
2. Let the model ask in chat and draft when it has enough. Costs one AI action per message, and a small local model can ask things that make no sense or never stop asking.
3. Two pages: the wizard for simple cases, the chat for everything else. Two sets of copy, two flows to keep working, and the owner has to choose before knowing which fits.

## Decision

Option 2, in `packages/engine/src/ai-chat.ts`, `apps/api/src/ai-chat.ts` and `apps/web/src/BuildWithAi.tsx`, with the wizard removed.

- One message is one model call. The reply is one JSON object, either `{"kind":"question","text":…,"choices":[…]}` or `{"kind":"draft","name","summary","definition"}`, so the page never guesses. `parseChatReply()` checks the definition with the same `definitionSchema` as a hand-built workflow.
- The prompt says what a question may be about (what starts it, who knows or decides, where it goes, how much or how often), one at a time, at most six, never twice, never a password, key or card number. Six answered questions make the route add one line telling the model to draft, so a conversation cannot only ask.
- Choices are buttons, and the text box always accepts the owner's own words for the same question.
- The current draft travels beside the conversation (`current`), not inside it, so the visible words stay words. `withPeople` and `withLabels` still swap the owner's address in and out.
- Connected apps are sent as a fixed list of four names, checked by the schema, so no typed text reaches the prompt through that field.
- One repair round on a malformed reply or a draft with lint warnings, as `POST /ai/draft` does. A question is returned as it is: repairing it would make the person wait twice for the same question.
- At most 20 messages of 2,000 characters, the oldest dropped by the page, 10 requests a minute per IP, owners only, one AI action per message under the plan.
- The page is one centered box with no greeting and no example chips, so it reads as a chat rather than a form. Once a message is sent, the conversation grows above the box.
- A draft the checker finds nothing to fix is created and turned on in the same step, and the page opens it. A warning, or a publish the server refuses because an app it needs is not connected, keeps the draft on the page with Turn it on, Save as draft and Change something. This replaces decision 0017's rule that an AI draft is never published by itself; the definition schema, the lint pass and the editor's off switch stand in for the review press.
- No model, or a failed call: the same page offers the closest ready-made automation, now read from what was typed (a mention of approval gives Purchase request, "website" or "inquiry" the inquiry reply, anything else the office request).

## Consequences

- A conversation costs more than one draft: three questions and a draft is four AI actions. The page says so under the box and shows the plan's count.
- An AI-built automation can be live before a person reads it. A draft that passes the checker and does something the owner did not mean starts taking real events at once, so the editor opens on it and the run history is the place to notice.
- A small local model often asks badly or answers with the wrong shape. The repair round, the six-question cap and the ready-made fallback keep the page usable, and the error names the model so a larger one can be picked.
- The four fixed questions are gone, so the page cannot work without a model. It still offers the ready-made automations when there is none.
- The public demo stays scripted: it says no model is called, and that stays true.
- `POST /ai/draft` remains for the editor's "Ask the AI", which changes one existing draft and does not need a conversation.
