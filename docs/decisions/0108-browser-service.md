# 0108: Browser service and the browser step (phase B2)

## Context

Owners want Daloy to use web pages the way n8n's browser nodes do: open a supplier's page, click through it and read a price. Phase B1 (decision 0107) reads a page with a plain GET. B2 needs a real browser for pages that only show their content after scripts run or after a click. Phase B3 will build an AI agent on the same browser, so the service has to serve both a fixed action list and a step-by-step agent.

A browser is the riskiest thing Daloy has run so far. The page's own scripts run, they can make any request the browser allows, and the server sits next to Postgres and the API. n8n's nod (github.com/n8n-io/nod, Apache-2.0, research preview) runs Chromium in a hardened container behind a forward proxy that only allows public addresses, which is the model used here.

## Options

- Chromium inside the worker process, or a separate service. Inside the worker it would share the network with Postgres and the memory with every other step.
- Guard requests with `page.route` alone, or with a forward proxy. `page.route` does not see service worker requests, does not stop DNS rebinding (the browser resolves the name again after the check) and has gaps around WebSockets. A proxy sees every connection the browser makes.
- One proxy for the service, or one per job. Per job, refusals belong to that job, and B3 can add a per-step domain allowlist to that job's proxy without touching others.
- The guard's address list copied into the service, or shared. A copy drifts.

## Decision

- `apps/browser` is a separate Node service running `playwright` 1.65.0 Chromium (Apache-2.0), the same version as the root `@playwright/test`. It runs in its own compose service built from `mcr.microsoft.com/playwright:v1.65.0-noble` (pinned by digest, amd64 and arm64). It publishes no port. The worker calls it at `BROWSER_URL` with `Authorization: Bearer <BROWSER_TOKEN>`; the token is compared as SHA-256 digests in constant time, and the service refuses to start with a token under 32 characters.
- Every job gets a fresh browser context and its own proxy, closed when the job ends. `BROWSER_CONCURRENCY` (default 2) jobs and sessions run at once; one more answers 503, which the worker retries. A job has `BROWSER_JOB_SECONDS` (default 60) in all, and each action waits at most 10 seconds for its element.
- Network guard, adapted from nod's `src/providers/agent-browser/network.ts` (notice kept in `apps/browser/NOTICE`):
  - Chromium sends all traffic through the job's in-process forward proxy (`proxy.server` on the context, no bypass list; Playwright then adds `<-loopback>`, so even 127.0.0.1 goes through the proxy). The browser itself is launched with a deny-all proxy, so a context opened without its own proxy reaches nothing.
  - The proxy resolves each host once, refuses it when any answer is in `BLOCKED_RANGES` or the port is not 80 or 443, and connects to the exact address it checked. That covers DNS rebinding, redirects, iframes, `fetch`, WebSockets (Chromium tunnels them with CONNECT) and service workers. A plain-http upgrade without CONNECT is dropped.
  - `BLOCKED_RANGES` moved from `apps/worker/src/steps/ssrf.ts` to `packages/engine/src/browser.ts`; the worker re-exports it, so the HTTP step and the browser read one list.
  - `context.route("**")` stays as a second check and aborts anything that is not http or https.
  - Downloads are off (`acceptDownloads: false`), service workers are blocked, a file chooser is taken over and never answered, and passkeys always fail with `NotAllowedError` (an init script, the same idea as nod's). Chromium also runs with QUIC off and WebRTC limited to proxied UDP.
  - The service sits on its own compose network, `browser`, with only the worker. It reaches the internet; Postgres, Mailpit and the API are not on that network.
  - Private addresses are allowed only through the proxy's `exempt` option, which only tests pass (the local fixture site's address and port). `main.ts` never sets it and no env var does.
- Container hardening, following nod's compose browser service: `cap_drop: [ALL]`, `no-new-privileges`, `read_only` with tmpfs for `/tmp` and `/home/pwuser`, `init`, `pids_limit: 1024`, `shm_size: 1g`, `mem_limit: 2560m` (two jobs of about 1 GB each). Chromium's own sandbox is off (Playwright's default in containers); the container is the sandbox.
- The step: `url` (template) and up to 20 `actions`: `goto` (template address), `click` (a CSS selector or visible text), `fill` (selector and template value), `wait` (selector), `extract` (selector into a name) and `screenshot` (at most 5). Selectors, texts and names are literals. The browser step resolves without secrets, like every step but HTTP.
- Output: each extracted name at the top level (`{{steps.<id>.output.price}}`), `url` (the final address) and `screenshots` (`FileRef`s). Screenshots are stored as uploads of the run, next to a form's files, after the worker checks they are PNGs under 5 MB. `url`, `screenshots`, `mocked` and `wouldDo` cannot be extract names.
- `fill` refuses a field with `type=password`, an `autocomplete` of `current-password`, `new-password`, `one-time-code` or any `cc-*` token, or a name or id that looks like a card field, and refuses any value that is a card number (13 to 19 digits passing the Luhn check). The check runs on the element right before typing, in the service, for the action list and for a fill by ref.
- Retries: 503 (busy, nothing ran) is retried. A lost answer or a time-out is retried only when the list has no click and no fill; otherwise it is an unknown outcome and goes to review, Daloy's rule for anything that may already have happened.
- A mocked test run opens nothing and returns `wouldDo` lines ("Would click the element with the text "Add to cart""), with typed values counted and never shown. Each extract name is present and empty, so later steps still resolve.
- The step counts one web request against the daily cap. It is in `HOSTED_ONLY`, so a small local model's draft prompt leaves it out.

## The service API (for B3)

All calls but `/health` need the bearer token. Errors are JSON `{ error, refused? }`: 400 for a bad body, 401 for the token, 404 for an unknown session, 422 for a refused address, a refused field or a failed action, 503 when busy, 504 past the time limit.

- `GET /health`: `{ ok: true }`, for the compose healthcheck.
- `POST /run` with `{ url, actions, timeoutMs? }`: runs the action list in one context. Answers `{ url, extracted, screenshots: [base64 PNG], refused: ["host:port"] }`. The browser step uses this.
- `POST /sessions` with `{ url }`: opens a context, keeps it, and answers `{ id, url, title, snapshot, refused }`. `snapshot` is `page.ariaSnapshot({ mode: "ai" })`: the accessibility tree as YAML with refs such as `[ref=e7]`, up to 40,000 characters. A session takes a concurrency slot, closes after `BROWSER_JOB_SECONDS` without a call, and after 5 minutes in all.
- `GET /sessions/:id/snapshot`: a fresh snapshot of the same page.
- `POST /sessions/:id/act` with `{ ref, action: "click" | "fill", value? }`: acts on the element with that ref from the latest snapshot (`page.getByRef`), then answers a new snapshot. A fill goes through the same password and card checks.
- `DELETE /sessions/:id`: closes the context and frees the slot.

B3 still needs, and this service does not have yet: a per-step domain allowlist (planned in the job's proxy, next to the address check), and pauses for owner approval before irreversible actions (the worker holds the session open while it waits, or reopens it). A session's 5-minute total limit may need raising for an agent that waits for a model between actions.

## What was taken from nod

- The forward proxy design: an in-process HTTP proxy on 127.0.0.1, CONNECT tunnels for https, resolve once and connect to the checked address, hop-by-hop proxy headers removed, sockets tracked and destroyed on close. Daloy's version checks `BLOCKED_RANGES` instead of nod's public-address test, limits ports to 80 and 443, records refusals per job, adds the deny-all backstop and drops plain-http upgrades instead of forwarding them.
- The passkey init script idea, rewritten.
- The container settings: `cap_drop`, `no-new-privileges`, `read_only` with tmpfs, `init`, `pids_limit`, `shm_size`, a memory limit, and the QUIC and WebRTC flags.
- Not taken: nod's vault, its agent loop and its desktop browser. B3 decides what to take from those.

## Consequences

- The image is large: the Playwright base is about 1 GB to download for arm64 and 3.65 GB on disk, and the built service image 4.1 GB, because the base also carries Firefox and WebKit. docs/deployment.md has the numbers.
- `BROWSER_TOKEN` is a new required value in `.env`. An installation that pulls this change must add it before `docker compose up`.
- Pages on ports other than 80 and 443 do not load, and a site that sends WebSockets over plain http without CONNECT does not work.
- A page could change a field's type between the check and the typing. The value typed is always the owner's own template value, and card numbers are refused by value as well, so the remaining risk is owner data in a field the owner did not mean.
- Sites may block automated browsers or forbid them in their terms. The owner chooses the sites; the step does nothing to hide that it is a browser.
