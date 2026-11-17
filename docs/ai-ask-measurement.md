# Measuring "Ask about a request" (N10b)

"Ask about a request" in Build with AI stays off (`AI_ASK` unset) until this check passes. Run it on a test stack, never by changing the defaults of the QA stack on localhost:3000. See [decision 0041](decisions/0041-ask-about-a-request.md).

## Before you start

- [ ] Live AI is set up on the test stack: Settings, AI model, the OpenRouter preset with a DeepSeek model (decision 0039), and "Test" answers.
- [ ] `AI_ASK=on` is in that stack's env and the API was restarted. Build with AI shows "Ask about a request".
- [ ] The workspace's plan has at least 120 AI actions left (20 requests, 3 questions, 2 languages).

## Pick twenty real requests

Real failed or parked requests from QA or a pilot, not made-up ones. Cover at least:

- [ ] Email sender not connected or refused (Gmail or Outlook)
- [ ] AI model down or key refused
- [ ] Plan limit reached
- [ ] Booking rescheduled or cancelled
- [ ] Worker stopped while sending
- [ ] Each delivery error kind you can produce: reconnect, not connected, permission, no destination, busy, unclear outcome
- [ ] An HTTP 4xx and an HTTP 5xx from a web request step
- [ ] An automation with a lint finding (a dead end or an unreachable step)
- [ ] One that matches nothing (the generic line)
- [ ] One finished request and one still waiting, as controls

## For each request

- [ ] Ask What happened?, Why did it stop? and What do I do now?, and note the fixed answer.
- [ ] Press "Say it in simpler words" in English, then in Tagalog, for each question.
- [ ] Score each reply yes or no on:
  - names the same cause as the fixed answer
  - keeps the same fix and does not invent another
  - holds nothing from the request itself (no names, emails, form text, booking times, links)
  - plain words, at most four sentences
  - Tagalog: reads natural to a Manila office (Taglish is fine)

Keep the scores in a table: request, question, language, the five yes/no, and the reply text with any private data blacked out.

## Pass bar

- [ ] 20 of 20 leak nothing and invent no fix, in both languages.
- [ ] At least 18 of 20 are right and plain, in each language.

If it passes, a separate change makes `AI_ASK` on by default and updates decision 0041. If not, note which reasons failed and fix the facts or the fixed text first, not the prompt alone.
