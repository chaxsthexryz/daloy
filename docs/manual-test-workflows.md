# Manual test: local AI model and five workflows

This is a hands-on test of the console on your own PC, with Qwen running locally through llama.cpp. Nothing here sends real email: Mailpit at http://localhost:8025 catches every message.

## 1. Start Qwen with llama.cpp

llama.cpp's `llama-server` has no account and no key of its own. The API key is any secret you choose and pass with `--api-key`; kymavo must send the same value.

1. Pick a key. In PowerShell:

   ```powershell
   -join ((48..57)+(97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
   ```

   Copy the output. If `.env` already has a value in `LLM_API_KEY`, you can reuse that value instead.

2. Start the server (change the model path to your file):

   ```powershell
   llama-server -m C:\models\Qwen3.5-4B-Q4_K_M.gguf --host 127.0.0.1 --port 18434 --api-key PASTE_KEY_HERE -c 8192 --jinja
   ```

3. Check it answers:

   ```powershell
   curl.exe http://127.0.0.1:18434/v1/models -H "Authorization: Bearer PASTE_KEY_HERE"
   ```

   You should see your model's name. Use that exact name for `LLM_MODEL`.

If kymavo later says it cannot reach the model, Docker cannot see `127.0.0.1` on your PC. Restart the server with `--host 0.0.0.0` (keep the `--api-key`, and only do this on a trusted network).

## 2. Point kymavo at it

Open `.env` in the daloy folder in a text editor and set these lines. Do not paste the key into chat or commit `.env`.

```
LLM_PROVIDER=openai
LLM_BASE_URL=http://host.docker.internal:18434/v1
LLM_MODEL=Qwen3.5-4B-Q4_K_M
LLM_API_KEY=PASTE_KEY_HERE
SHARED_LLM_KEY=open
AI_ASK=on
```

- `SHARED_LLM_KEY=open` lets your local accounts use this key. Keep it `off` on any public server.
- `AI_ASK=on` turns on "Ask about a request" in Build with AI. Keep it `off` on a public server until `docs/ai-ask-measurement.md` is done.

Then restart the stack (your data is kept):

```powershell
docker compose up -d --build
```

Open http://localhost:3000, sign in, go to Settings, then AI model, and press Test. It should answer from Qwen. A 4B model is slow on a CPU; a first answer of 20 to 60 seconds is normal.

## 3. Optional: drive kymavo from Hermes Agent

kymavo exposes its automations as MCP tools at `http://localhost:3000/mcp`.

1. In the console: Advanced, then API tokens, then create a token. It starts with `dly_`. Copy it once; it is not shown again.
2. In Hermes Agent's settings, add an MCP server with URL `http://localhost:3000/mcp` and the header `Authorization: Bearer dly_...`. Where that goes depends on your Hermes version; look for "MCP servers" in its docs.
3. Point Hermes's own model at the same llama.cpp server: base URL `http://127.0.0.1:18434/v1`, the same key, the same model name.
4. Ask Hermes: "List my kymavo automations" and then "Run the website inquiry automation with a test inquiry from Ana about a broken printer." Check the run appears under Activity.

## 4. Five workflows to test

For each one: build it, run it, then check the run page (the path diagram, the plain state, and Mailpit). Write down anything confusing, slow or wrong.

### Workflow 1: Website inquiry with AI triage and approval

Goal: AI sorts inquiries; urgent ones need your approval before the reply goes out.

1. New automation, then the Inquiry triage template. It already has an AI step that labels the message and a condition on that label.
2. Change the AI step's labels to `urgent` and `normal`, and ask it to summarise the inquiry in one line.
3. Change the condition to: AI label is `urgent`.
4. Urgent branch: an approval step (approver: you), then an email reply to the customer.
5. Normal branch: an email reply straight away, then a delay of 2 minutes, then a follow-up email ("Did this answer your question?").
6. Publish. Open the form link and send two inquiries: "Our system is down, customers cannot pay" and "What are your opening hours?"

Check: the first waits on you under Needs you, and its reply only appears in Mailpit after you approve. The second gets a reply at once and a follow-up 2 minutes later. Both runs show the AI summary.

### Workflow 2: Purchase request with a spending limit

Goal: big purchases need two approvals; small ones go through.

1. New automation, then the Purchase request template.
2. Add a condition: amount is greater than 5,000.
3. Over 5,000: approval by a manager, then approval by you, then an email to the requester saying it is approved.
4. Up to 5,000: an email to the requester saying it is approved, no approval needed.
5. On a rejection at either approval: an email to the requester with the reason.
6. Publish and send three requests: 1,200; 18,000 (approve both); 25,000 (reject at the second approval).

Check: each request ends in the right state (Done, or stopped with the rejection), the path diagram shows the branch it took, and Mailpit has exactly one message per request outcome. Invite a second user as the manager if you want to test two people.

### Workflow 3: Lead to booking with reminders

Goal: a customer books from a form on another website and gets a reminder; cancelling stops it.

1. New automation, then a template that takes bookings (Office requests with a booking time, or the one Build with AI drafts for "book an appointment"). Bookings it takes appear under Bookings in the menu.
2. Set the reminder to send 5 minutes before the booking, so you can watch it. If you cannot find a reminder setting, note it: that is a finding.
3. Publish, then on the form press Copy embed code.
4. Save this as `test-site.html` on your desktop, paste the embed code inside the body, and open the file in your browser:

   ```html
   <!doctype html><html><body><h1>My salon</h1><!-- paste here --></body></html>
   ```

5. Book a slot about 10 minutes from now. Book a second slot, then cancel it from Bookings.

Check: both bookings send a confirmation in Mailpit. The first gets its reminder about 5 minutes before. The cancelled one never gets a reminder.

### Workflow 4: Order intake from another app, with a failure

Goal: an order arrives by webhook, the AI pulls out the details, and a broken step explains itself.

1. New automation with a webhook trigger. Copy its URL.
2. Add an AI step: "From this message, return the customer name, item and quantity."
3. Add an HTTP step that posts the order to `https://example.invalid/orders` (this address can never work, on purpose).
4. Add an email to yourself: "New order: {{ the AI step's item }}".
5. Publish and send an order from PowerShell (replace the URL):

   ```powershell
   curl.exe -X POST "PASTE_WEBHOOK_URL" -H "content-type: application/json" -d '{\"message\":\"Hi, this is Ben. I need 3 boxes of A4 paper.\"}'
   ```

Check: the run stops at the HTTP step with Problem. "Why it stopped" explains it in plain words, and "Explain in simpler words" rewords it with Qwen (it uses 1 AI action). Then change the HTTP URL to a public test address you trust, or delete the step, and press Retry.

### Workflow 5: Build with AI, then ask about a request

Also worth a quick look: the Invoice follow-up and Booking no-show follow-up templates under New automation.

Goal: test the AI helper end to end with the local model.

1. Open Build with AI. Answer its questions for: "When a client sends an invoice question by email form, reply with the due date, and remind them 3 days before it is due."
2. Review the draft in plain words, then Save as draft. Open it, fix anything the model got wrong, and publish.
3. Run it twice from its form.
4. In Build with AI, open "Ask about a request", pick one of those requests and tap What happened?, Why did it stop? and What do I do now?
5. Go to Settings and open the usage view.

Check: nothing was saved before you pressed Save as draft. The answers match the run page. The usage view counts each AI call (the draft, any rewording, the AI steps). Note how good or bad Qwen's draft and wording were; that is the start of the 20-request check.

## 5. Five more, built with Build with AI

These come from the jobs Philippine small businesses and VAs do by hand. Paste each prompt into Build with AI, answer its questions with the suggested answers, then review the draft before Save as draft. The point is to test the helper as much as the workflow, so for each one write down:

- Did it ask sensible questions, and how many?
- Did the draft match the prompt? What did you have to fix by hand?
- Did the review in plain words describe what it built correctly?
- How long did Qwen take?

### Workflow 6: Online shop order to a sheet, with payment check by a person

Prompt:

> When a customer submits an order form with their name, mobile number, item, quantity and GCash reference number, add the order to my orders sheet, send the customer a "we got your order" email, and ask me to confirm the payment. When I approve, email the customer that the order is paid and being packed. When I reject, email them that we could not find the payment.

Suggested answers: who approves: you; where it goes: Google Sheets (or email to yourself if Sheets is not connected).

Run: three orders, approve one, reject one, leave one waiting.

Check: a screenshot or reference number alone never marks an order paid; only your approval does. The waiting one shows Needs you.

### Workflow 7: Unpaid invoice reminders that stop when paid

Prompt:

> When I enter an invoice with the client's name, email, amount and due date, email the client the invoice details. Three days before the due date, send a polite reminder. On the due date, if I have not marked it paid, send a firmer reminder and tell me. Stop all reminders as soon as I mark it paid.

Suggested answers: marked paid by: your approval; for the test, use due dates a few minutes away if the helper allows short delays.

Run: two invoices; mark one paid before its first reminder.

Check: the paid one gets no reminders after you mark it. Compare the result with the ready-made Invoice follow-up template.

### Workflow 8: Salon booking with reminder and no-show follow-up

Prompt:

> When a client books a haircut or massage with their name, email, service and time, send a confirmation. Send a reminder 1 hour before. If I mark them as a no-show, wait an hour and send a link to book again. If they cancel, send a "sorry to miss you" email and no reminder.

Suggested answers: reminder: 1 hour before (or 5 minutes for the test); rebooking link: your form link.

Run: one normal booking, one cancelled, one marked as a no-show.

Check: each gets exactly the emails it should. Compare with the Booking no-show follow-up template.

### Workflow 9: Customer question answered by AI, sent only after you check it

Prompt:

> When a customer asks a question through my website form, have the AI draft a short, friendly reply in English or Tagalog, whichever they used. Show me the draft and only send it after I approve. If the question is about a refund or a complaint, do not draft anything; send it straight to me instead.

Suggested answers: reply language: same as the customer; approver: you.

Run: one English question about opening hours, one Tagalog question ("Magkano po ang delivery sa Cavite?"), and one refund complaint.

Check: no AI reply ever goes out without your approval. The complaint skips the AI. Note how good Qwen's Tagalog is; that feeds the 20-request check.

### Workflow 10: VA weekly report

Prompt:

> Every Friday at 5 pm, collect this week's requests, how many finished, how many are waiting, and how many had a problem, have the AI write a three-line summary, and email it to my client. If more than two had a problem, also send me a separate warning.

Suggested answers: day and time: Friday 5 pm (for the test, every 5 minutes, then change it back); recipient: an address you control (Mailpit catches it).

Run: let it fire twice on the short schedule.

Check: the numbers in the email match the Activity page. The warning only appears when there were more than two problems. If the helper cannot count runs on its own, note it: a weekly report may need a new built-in step, which is a useful finding.

## 6. When you are done

- Set `AI_ASK=off` and `SHARED_LLM_KEY=off` in `.env` before you put this installation anywhere public, then run `docker compose up -d`.
- Delete the test automations you do not want to keep, and revoke the Hermes API token under Advanced, then API tokens.
