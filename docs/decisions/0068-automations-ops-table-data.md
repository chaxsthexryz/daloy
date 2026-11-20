# 0068: Automations ops table, what the numbers can honestly show

## Context

The approved Doop frame for Automations (A1) shows runs today, success over seven days, a seven day bar chart per automation, an Owner column, Owner and App filters, and "Runs used this month 1,240 of 2,000". The API has no endpoint for per automation run counts, no owner field, no list of apps per automation and no monthly run meter. `GET /runs` returns the newest 50 runs only. This task allowed web changes only.

## Options

1. Change the API to add run statistics, owner and apps to `GET /workflows`. Accurate, but outside this task and it touches shared API code.
2. Show the frame's numbers with placeholder or estimated values. Rejected: the owner rule is no fake numbers.
3. Derive what the current API supports, label the figures that can be partial, and leave out what has no data.

## Decision

Option 3.

- Runs today, success rate and the bars come from `GET /runs?test=false`. When 50 runs come back and the oldest is still inside the window, the strip and the table say the figures use the newest 50 runs. The rate counts succeeded and failed runs only, so a run waiting for a person does not lower it.
- The last tile shows live automations out of the plan limit from `GET /usage`, instead of monthly runs. It is hidden when the call fails.
- Trigger comes from `GET /workflows/:id` per row, requested four at a time after the list renders. A row shows an ellipsis until its answer arrives.
- The Owner column and the Owner and App filters are omitted.
- Drafts are rows with the status Draft, not a separate group.

## Consequences

- With more than 50 runs in a week the bars and rates describe the newest 50 and say so. A list endpoint that returns per automation counts, trigger type, owner and app keys would remove the cap, the extra requests and the omissions. That is the follow-up.
- A workspace with many automations makes one detail request per automation on each first load. Fine for the plan limits today.
- Phone has no approved frame. Rows stack and the panel opens as a bottom sheet, following the sheet pattern in the handoff doc.

## Update: the list endpoint replaces the 50 run sample

The follow-up named above is done. `GET /workflows/overview?tz=<IANA zone>` returns, for each automation in the workspace, its non-test run counts (today, the last seven calendar days, succeeded, failed, and seven day bars), its trigger type, its owner and the apps its steps use. The Automations page uses it and the cap is gone.

- Counts are grouped in the database in the viewer's time zone, so "today" and the bars follow the viewer's calendar. The zone is checked with ICU in zod (default Asia/Manila) and passed to Postgres as a bound parameter. A bad zone is a 400.
- The route has the same guards as `GET /workflows` (a session, the operate roles) and every query is filtered by the caller's workspace. It runs three queries however many automations or runs exist.
- Trigger type and apps come from the live version, or the newest version when nothing is live, so a draft shows its trigger too. Apps are listed once each in step order, using provider keys such as `slack` and `google_sheets`. Drive and PayMongo steps are included here although publishing does not check their connections.
- Owner is the workspace owner's email, the same on every row. An automation has no creator column. A per automation owner needs a `created_by` column and a migration, which this change does not add.
- The page no longer fetches `GET /workflows/:id` for every row. The trigger comes from the overview. The selected row loads its own detail and its newest runs (`GET /runs?workflowId=...&test=false`) for the panel. The "newest 50 runs only" notes are removed.
- The Owner column and the Owner and App filters are still not on the page. The data is there for them; showing them is a design change.
- `GET /runs` keeps its limit of 50, which still applies to the "needs you" list and to the panel's recent runs.
