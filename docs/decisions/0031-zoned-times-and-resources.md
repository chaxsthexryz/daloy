# 0031: Zoned times and resources

## Context

QA-02 (spa appointments) in the eight-workflow report took the appointment time as plain text, so "2027-01-20T32:00" and a date in 2020 were both booked. A reminder could only wait a fixed number of seconds after the booking, and the therapist was free text that nothing could check. A mocked builder test of a one-hour delay reported a wake-up time one second away. P6a adds the pieces P6b's bookings need. Bookings, conflicts, opening hours and lead times are out of scope here.

## Options

1. A date library (Luxon, date-fns-tz) for zone conversion. It adds a dependency to the engine, which the console bundles too, and its zone data can drift from the runtime's.
2. Temporal. Node 24 does not ship it.
3. `Intl.DateTimeFormat`, which carries the IANA database in Node and in browsers, plus a small conversion function.

For a wall time that happens twice when the clocks go back: take the earlier one (Temporal's default), or refuse it.

For the resource value in the payload: the id only, or the id with its name.

## Decision

Option 3, in `packages/engine/src/zoned.ts`.

- A `datetime` field needs `timezone` (an IANA name the runtime lists, or `UTC`; offsets such as `+08:00` and abbreviations such as `PST` are refused) and may set `slotMinutes` (1 to 1440). Other field types refuse both.
- Input without an offset is wall time in the field's zone, which is what `<input type="datetime-local">` sends. Input with `Z` or an offset is that instant. Either way the instant is then read in the field's zone, and the slot grid, counted from local midnight, applies there. So a sender in Kathmandu cannot pass a Manila slot check with its own clock.
- Conversion: the wall time is read as if it were UTC, and the zone's offsets one day before and one day after are tried. Each candidate instant is kept only if the zone shows that wall time at it. No zone changes its offset twice within two days, so this finds every instant: none in a spring-forward gap, two in a fall-back overlap.
- A gap is refused: `does not exist in America/New_York (the clocks skip it)`. An overlap without an offset is refused too, and the message shows the earlier offset to send. The approved choice: a booking system should not guess which 01:30 a customer meant.
- Also refused: impossible dates and times (32:00, 30 February), a time that is not in the future, off the slot grid, or not on a whole minute. A zero fraction (`.000Z`, what `toISOString()` sends) is fine.
- The stored value is wall time with the zone's offset, `2027-01-20T14:00:00+08:00`, so emails show local time and later steps can still find the instant.
- The delay step takes either `seconds` or `until` (a template) with an optional `offsetSeconds` (-30 to +30 days). `until` must resolve to a time with an offset; anything else fails the step for good with the value in the error. When the wake-up time has passed, the step takes the branch `late` without waiting. A delay with `until` may have a `late` edge next to its usual one. Without one, the run ends at the delay and its output says `skipped: "The wake-up time had passed, so the steps after this delay did not run."`, shown in run history as "Skipped: ...". A reminder for an appointment that is closer than the reminder offset is not sent.
- A mocked test run still waits at most one second, but the delay's `resumeAt` is the time a live run would wake up, with `mocked: true`.
- Workspace resources: a `resources` table (id, workspace, name unique per workspace, active). Owners add, rename, archive and restore them; every member can list them. There is no delete, since runs and P6b's bookings point at the id.
- A `resource` field takes an id. `parsePayload` gets the workspace's active resources from the caller and accepts only those; with no list it accepts nothing. The stored value is `{ id, name }` with the name read from the row at submission, so `{{trigger.therapist.name}}` works in emails and a later rename or archive leaves earlier runs as they were.
- Every entry point loads the list for the workflow's own workspace: the hosted form (which also renders it as a `<select>`), webhooks, test runs, the Run button and MCP (where the tool schema describes the choices).
- The hosted form gives the time input a browser `step` only when the slot divides the day (5, 15, 30, 45, 60, 90 minutes and so on). The browser counts steps from 1970-01-01T00:00, which meets every local midnight only then; a seven-minute grid gets whole-minute steps, so the browser never blocks a slot the server accepts. (Fix from Astra's review of ad0173f: 00:07 on a seven-minute grid was blocked.)
- A webhook call or a Run button run whose event key already started a run gets that run with `duplicate: true` before its payload is checked again. Without this, replaying an accepted event after its resource was archived, or after its time had passed, answered 400 although the event had been taken. A new key still gets every check. (Same review.)

## Consequences

- No new dependency. Zone data is whatever the Node and browser ICU carry, so a zone created after the runtime was built is refused until Node is updated.
- A customer who picks 01:30 on a fall-back night gets a refusal they cannot fix from a datetime-local input; they pick another time. Webhooks and MCP can send the offset.
- Payloads are parsed only where they come in. A stored datetime is never checked again, so a run that waits past the appointment still runs.
- The replay lookup reads the key from the raw body. An `eventKey` template on a declared field whose stored form differs (trimmed text, a datetime, a resource) matches only after the checks, so such a replay can still get a 400. MCP checks its arguments before Daloy sees them, so an MCP retry with the same `idempotencyKey` after a resource was archived or a time passed gets an error, not the first run. Builder test runs are checked again too, by design.
- The visual builder has no handle for a `late` edge. It can be set through the API, MCP or Build with AI; the delay's help text in the editor explains what happens without one.
- Resource kinds (therapists versus rooms), opening hours, lead times and conflicts are P6b or later. A form's resource field lists every active resource of the workspace.
- Migration 0018 adds one table and changes nothing else. All 64 versions in the development database still parse.
