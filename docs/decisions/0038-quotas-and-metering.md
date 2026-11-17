# 0038: Plans, quotas and metering

## Context

N6 lets the operator run Daloy for paying workspaces, and pay for the shared AI key. Until now nothing limited how much one workspace could use. A workspace could publish any number of automations, schedule one every minute, and send AI and web calls without a cap. Decision 0024 limits only the installation's shared mail server, by UTC day, and only for approved accounts. Decision 0035 closed the shared AI key behind `SHARED_LLM_KEY` until a per-workspace quota existed. Payment is manual, monthly, by GCash or Maya, so no payment code is needed.

## Options

- Where plans live: a `plans` table, or constants in code.
- How to count: a log row per action summed on demand, or one counter per workspace, kind and period.
- When to count: after the outside call succeeds, or before it.
- Retries: count every attempt, or once per step.
- Who sets a plan: an API route and an admin page, or the operator with SQL.
- AI cycle: the calendar month, or the workspace's own plan start date.

## Decision

- Plans are data in code, `PLANS` in `packages/db/src/usage.ts`. A change to a limit is a code change and a release, which also leaves a record in git. The column holds only the plan name.

| | Pilot | Business | Business Plus |
| --- | --- | --- | --- |
| Live automations | 1 | 5 | 15 |
| AI actions a cycle | 100 | 500 | 2,000 |
| Email recipients a day | 100 | 300 | 1,000 |
| Web requests a day | 200 | 1,000 | 5,000 |
| Schedule at most every | 60 min | 15 min | 5 min |

- The plan is `users.plan`, nullable, with a check that allows only the three names, and `users.plan_started_on`, a date. Only the operator sets them, with SQL ([operations](../operations.md)). No API route changes a plan.
- Counters are rows in `usage_counts`, one per workspace, kind and period. `claimUsage()` adds to a row with one `INSERT ... ON CONFLICT DO UPDATE ... WHERE used + n <= limit`, as decision 0024 does for shared mail. The row lock makes the limit exact across any number of API and worker processes. When the `WHERE` is false, no row comes back and the claim throws `QuotaError`.
- Counting happens before the outside call. A provider call that then fails still used its action. This errs on the side of the operator's bill, and it is the only way to hold a limit when two steps run at once.
- Each claim carries the step's key. `usage_claims` has a primary key on workspace, kind and key. A retry of the same step finds its key and does not count again. The key and the counter are written in one transaction, so a step refused for quota leaves no key behind and can be counted when it is retried after the reset.
- AI actions reset on each workspace's plan start date, every month, in Manila time (UTC+8). A start on the 31st resets on the last day of shorter months. Email recipients and web requests reset daily at Manila midnight. A workspace with a plan but no start date uses the first of the month.
- What counts: an AI step, or one "Build with AI" request (a draft is one action, whatever its repair try does). An email step counts its recipients. An approval step counts one email for its link. An Outlook step counts its recipients. An HTTP step counts one request. Test runs with mocked steps count nothing. A test run with "live calls" counts like a real run. Sheets, Slack and Teams steps and form submissions are not counted.
- At a limit the step fails at once with a plain message, nothing is sent, and the run keeps its data. The owner presses Retry after the reset or a plan change. The error is not retryable and its outcome is `not_sent`, so the run is not retried on its own and needs no review.
- Form submissions and webhooks are never blocked. A customer who fills in a form always gets their reference, and the run waits for the owner's plan.
- No plan means no limits. Usage is still counted, so the operator can see what a workspace uses before choosing a plan for it.
- The shared AI key (`LLM_API_KEY`, `SHARED_LLM_KEY=open`) is sent only for a workspace that has a plan. A sign-up without one can use only its own key or a local model.
- The schedule interval is checked on publish: the smallest gap in the next 10 fire times (`cron-parser`, UTC) must not be below the plan's minimum, or the API answers 400. It is checked again when the schedule fires: the worker skips a fire if the workflow already started a real run within the interval, less 30 seconds so an exact hourly cron is not skipped. The second check covers a plan changed after publishing.
- The live automation limit is checked on publish, with the owner's `users` row locked (`FOR UPDATE`) from the check to the save. Two publishes cannot both take the last slot. Over the limit the API answers 403. Publishing a workflow that is already live is always allowed, so lowering a plan never breaks an existing automation.
- `GET /usage` returns the plan, limits, use and reset dates. The console shows them under Settings and warns from 80%.

## Consequences

- The plan table cannot be edited without a release. That is the point, and a table can be added if the operator needs to change limits often.
- A provider failure still costs an action. A retried attempt of the same step does not cost another.
- The email counter applies to a workspace's own Gmail and Outlook sends too, not only the shared server. The shared server's own limit from decision 0024 stays, by UTC day, and a send must pass both.
- Lowering a plan leaves live automations above the new limit running. Only new publishes are refused.
- A workspace can use its whole daily email count in one burst. There is no per-minute limit beyond the existing route limits.
- Business Plus allows 1,000 email recipients a day. A normal Gmail account allows fewer, so for a workspace that sends through its own Gmail, Gmail's refusal shows first.
- Left for later. The SMS limit comes with N7. The "Send a test email to me" button and the AI settings "test" are not counted: both are limited per minute and send fixed text. Payment and invoicing stay manual. A plan change is an SQL line, and an admin page can come later.
