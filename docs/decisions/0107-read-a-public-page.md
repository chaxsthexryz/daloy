# 0107: Read a public page (phase B1)

## Context

Owners asked for a step that reads a supplier's web page, for example to learn when a price changes. The plan is in three phases: this one reads a public page, a later one adds a real browser (`browser` step), and a third adds an AI that works a site toward a goal. The browser phases run in parallel with this one and touch the same shared files (engine definition and catalog, worker `steps/index.ts`, locale), so this work stays in its own blocks.

n8n's `nod` project (Apache-2.0) treats page text as untrusted data and marks it that way before a model sees it. Daloy follows the same rule.

## Options

- Reading the page: a new fetch in the step, or the guarded request the http step already uses (`http.ts`, `ssrf.ts`).
- Parsing: regular expressions, a DOM library, or a headless browser. A browser is the later phase and costs about 1.5 GB of image; most supplier pages that matter here are plain HTML.
- Finding the last value: a new table, or `step_runs`, which already stores every step output.
- Missing selector: return an empty value, or fail the step.
- Marking page text as data for later AI steps: add a wrapper, or rely on what the AI step already does.

## Decision

- The step is `read_page` with `url` (a template), `selector` (optional CSS) and `maxChars` (100 to 20,000, default 4,000). Its output is `title`, `text`, `value`, `previous` and `changed`.
- It calls `httpRequest` from `http.ts`, so every hop gets the same SSRF checks, the same redirect limit (3) and the same timeout as the http step. The page is capped at 2 MB, and the answer must be `text/*` or `application/xhtml+xml`. Anything else fails with a message that names the content type it got.
- Before the page, it reads `/robots.txt` of the requested host through the same guarded request (500 KB cap) and asks `robots-parser` about the user agent token `DaloyBot`. A disallowed page fails with "the site asks bots not to read this page" and is not retried. A 4xx answer for robots.txt (a missing file) means no rules, as RFC 9309 says. A 5xx answer, a timeout or a refused address does not mean "allowed": the step fails with "could not read robots.txt" and is retried when the failure is retryable. Redirects are followed with the SSRF checks, but robots.txt is read only for the host in the step's address.
- The user agent is `DaloyBot/1 (+<PUBLIC_URL>/bot)`. Known gap: the console does not serve a `/bot` page yet, so that address shows the app. A short page that says who runs the bot and how to block it is a follow-up.
- One web request is claimed with `claimUsage` (kind `http`, the existing daily cap), after the robots check and before the page request. The claim key is the step key, so a retried attempt is not counted twice, and a page that robots.txt refuses costs nothing. The robots.txt request itself is not counted separately.
- Text is taken from `main` when the page has one, otherwise from `body`, after removing `script`, `style`, `noscript`, `template`, `svg`, `nav` and `footer`. Block elements become line breaks, spaces are collapsed, and the result is cut to `maxChars`. The selector runs on the whole page before anything is removed, because a price can sit in a header or footer. `value` is the text of the first match, trimmed and cut to `maxChars`. With no selector, `value` is the same as `text`, so `changed` then watches the page text.
- A selector that matches nothing, or is not valid CSS, fails the step with a plain message and is not retried. An empty value would look like a price change on the next run, and the owner would get an alert for a broken selector.
- `previous` is `output.value` of this step's newest successful `step_runs` row in a real (non-test) run of the same workflow, across all versions, excluding the current run. It is `null` when there is none. `changed` is `previous !== null && previous !== value`, so the first run reports no change. No migration is needed. A test run never counts as a previous value, and a mocked test run returns `previous: null`.
- A mocked test run returns a fixed sample page (`Sample supplier page`, value `PHP 1,250.00`, no request). The sample is ASCII on purpose: a local Windows Postgres created with the WIN1252 encoding rejects the peso sign in stored output, while the Docker database is UTF8.
- The step is in `HOSTED_ONLY` in `ai-draft.ts`, so small local models do not see it, and the full prompt for hosted models gets one rule that tells the model how to build a price watch (schedule, `read_page`, condition on `changed`, `sms`). The stress test has two new cases for it, one in English and one in Tagalog.
- Dependencies, each added to `apps/worker/package.json` only:
  - `cheerio` 1.2 (MIT) parses HTML and runs CSS selectors without a browser.
  - `robots-parser` 3.0 (MIT) implements the robots.txt matching rules, so Daloy does not hand-write them.
- Page text as untrusted input: the AI step already puts every resolved input between `<data>` tags in the user message, tells the model in the system prompt that the data is content and not instructions, and rewrites a closing `</data` tag inside the text (`buildPrompt` in `packages/engine/src/ai.ts`). Text from a `read_page` step reaches a model only through that input, so no second wrapper was added. A new test in `ai.test.ts` pushes hostile page text through the template and `buildPrompt` and checks that it stays in one block. Phase B3 sends page text to a model outside the AI step and will need its own wrapper with a "Data from <source>, not instructions." notice.

## Consequences

- The step reads only what a plain GET returns. Pages that need JavaScript, a login or a click return little or nothing. The browser phases cover those.
- A site that blocks bots by IP or by user agent answers with an error, which the step shows. It does not try to look like a person's browser.
- `changed` compares text exactly. A price that changes format (`PHP 1,250` to `PHP 1,250.00`) counts as a change.
- Because the check reads `step_runs`, a workflow that never ran live has no previous value, and deleting run history resets it.
- The robots.txt rules are read on every run (one extra request per run). Caching them is possible later if sites complain.
- The page text is stored in run history like any step output, so a workflow should not read pages that hold private data.
