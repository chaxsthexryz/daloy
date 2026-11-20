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
