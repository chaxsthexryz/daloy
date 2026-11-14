# 0025: Destination-aware secrets, stored previews and JSON body templates

## Context

The fec03cc regression report found:

- A secret with a quote, backslash or newline used in a JSON body was stored JSON-escaped, so the value-based redaction missed it. An operator, who is refused the secrets route, could read it in run history.
- A JSON body with an unquoted placeholder fell back to raw text, so crafted form data could add a key.
- An AI step could be given a secret, which redaction cannot take back once the model has seen it.

It also asked how an operator could be stopped from sending owner secrets to any address. Only the owner may save workflows, test runs or runs (`MANAGE = ["owner"]`), and the permission tests assert that operators get 403. The remaining path to a chosen destination is a secret-bearing request whose host comes from trigger or step data, which anyone who submits a form controls.

## Decision

- **Secrets only in HTTP steps.** The worker gives secrets to HTTP steps alone. Every other step resolves `{{secrets...}}` to nothing, and saving such a step is refused (400). This covers email, AI prompts, Sheets and chat payloads, and conditions, which could otherwise leak a secret one branch at a time.
- **Fixed destination.** In an HTTP step that uses a secret, the origin may depend only on literal text and secrets.
  - Save refuses a non-secret placeholder before the path, query or fragment starts.
  - At run time the worker resolves the URL once with trigger and step data blanked and once in full, and refuses the request if the origins differ. This catches `https://api.example.com{{trigger.path}}` with `@evil.test`.
  - A URL that is a secret (a Discord webhook, say) is allowed.
- **Stored previews.** Each step input is resolved twice:
  - with real secrets, for the request that goes out
  - with every secret as the literal `[secret]`, for what is stored, in the step input, the error input and queued payloads

  No string matching is involved for inputs. Outputs and errors come from outside, so they have every form of every secret value replaced: raw, JSON-escaped, URL-encoded and form-encoded (`secretForms`, `redactSecrets` in packages/db).
- **Redaction on read.** `GET /runs` and `GET /runs/:id` apply the same replacement, with the workspace's current secrets and its retired ones, before `maskSecrets`. Replacing or deleting a secret first copies its encrypted value into `retired_secrets`, which workflows never read. Run history is never rewritten. Replacing and deleting take a transaction lock on the workspace and secret name first (`pg_advisory_xact_lock`), so concurrent rotations and deletions run one after another and each retires the value the previous one wrote (retest of ecb5ade).
- **JSON body templates.** `parseJsonTemplate` reads a body as JSON:
  - Placeholders inside quoted strings are text; a whole-string placeholder keeps its type.
  - A bare placeholder in a value position is one typed value.
  - Raw control characters inside strings are escaped.

  The parsed template is filled value by value and serialised once. A body whose request declares a JSON content type must parse: otherwise the save is refused and a run fails without retrying. Other bodies are raw text, as before. The save checks run on save only, so older versions still load and run.

## Consequences

- An older workflow that referenced a secret in an email, Sheets row, chat note or AI step now sends nothing in that place. Before this, it sent `[secret]`. Saving it again shows the problem.
- All 47 saved versions in the development database pass the save checks. Its 29 bodies with a JSON content type parse, including multi-line Discord messages and an unquoted amount.
- Values deleted before `retired_secrets` existed are unknown to redaction.
- The owner can still send their own secret to any literal address they type. That is their choice, not an exfiltration path.
