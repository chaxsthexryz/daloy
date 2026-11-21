# 0080. Booking form: open times from active bookings, a taken time is told at once to a browser

## Context

The approved E9 frames show a booking form with a resource list, a date and time field, a row of open times with the taken ones struck out, and a page for "that time is no longer available". Before this, a form had no knowledge of bookings. The booking step decided at run time and ended on its `taken` branch, so a visitor learned nothing at the form.

## Options

1. Keep the form as it was and only restyle it.
2. Show open times and refuse a taken time at submit, for every caller.
3. Show open times, refuse a taken time for browsers only, and leave the API behaviour and the booking step as the authority.

## Decision

Option 3. `GET /forms/:id/slots?resource=&date=&field=` returns the day's slots with a taken flag. It answers only for an active resource of the form's own workspace (404 otherwise), returns times and no references or names, and is limited to 60 calls a minute per IP. A form with a resource field and a datetime field that has `slotMinutes` gets an empty open-times area and `<script src="/public/slots.js">`; the script fills the area and writes the chosen time into the date field. Without the script the form still works.

A form has no opening hours, so a day offers starts from 9 am to 5 pm on the field's grid, and a slot is as long as the grid. A slot is taken when an active, non-test booking of that resource overlaps it, or when it has already started. These are constants in `slots.ts`.

A browser (Accept prefers HTML) that sends a taken time gets the form back with a 409 notice, its answers kept and the time marked. An API caller is not refused: it is accepted and the booking step ends on its `taken` branch, so workflows that handle `taken` (for example a waitlist email) behave as before. The exclusion constraint on bookings stays the only check that counts.

## Consequences

- Owners cannot set opening hours yet. Add them to the field definition when a client needs it.
- A booking longer than the grid still shows only the first slot as taken for the later slots it covers, until the visitor submits. The submit check reads the chosen slot only.
- Another two visitors choosing the same free time at once are both accepted by the form and the second ends on the `taken` branch.
- The script is static and served from the API origin, so the pages keep `script-src 'self'`.
