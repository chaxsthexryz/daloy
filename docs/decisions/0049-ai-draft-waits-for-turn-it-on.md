# 0049: An AI draft waits for Turn it on

## Context

Decision 0048 turned a draft on by itself when the checker found nothing to fix. Two reviews (DeepSeek's and another model's) found the same problem: a checker-clean draft can still do something the owner did not mean, and once it is live it takes real events (emails, Sheets rows, Slack notes) before a person has read it. The checker tests the shape, not the intent.

## Options

1. Keep auto-publish and rely on the editor's off switch and the run history. The first wrong email has already gone out by the time anyone looks.
2. Publish only when there are no warnings and no connected apps are used. Narrower, but the owner still has not read it, and "no apps" is the case where a draft does the least.
3. Never publish without the owner's press, after a plain-words summary. One more tap, and the owner has read what will happen.

## Decision

Option 3, in `apps/web/src/BuildWithAi.tsx`.

- A draft is created only when the owner presses Save as draft or Turn it on. Turn it on publishes, then opens the automation.
- The draft always shows as a summary card, the last bubble in the thread: the trigger, each step, and who receives what and when, in plain words, with the checker's warnings and the apps it needs. Buttons: Turn it on, Change something, Save as draft.
- This restores decision 0017's rule that the AI never publishes by itself.
- The empty page gets four starter chips (Freelancer, Small shop, Salon, Virtual assistant). A chip fills the box and sends nothing. Enter sends, Shift+Enter is a new line.
- "Ask about a request" (decision 0041) leaves Build with AI. With `AI_ASK` on, a run page (`#/runs/<id>`, or `#/runs/<id>/ask`) has an "Ask what happened" button, and each Activity row with a reference has an "Ask what happened" link to it. The run's reference is loaded, so nothing is typed.
- Supersedes two bullets of [0048](0048-chat-build-with-ai.md): the auto-publish bullet, and "no greeting and no example chips".

## Consequences

- One more press before a clean draft is live. The summary is where the owner catches a wrong draft, so it has to stay plain and complete.
- A draft with warnings, or one whose publish is refused because an app is not connected, behaves as before: it stays on the page.
- No change to the API: `saveDraft` still takes `publish: true`, and only the page decides when.
- Asking about a request starts from a run, so there is no list of recent problems to pick from there. Activity's Problem filter does that job.
