# 0019: Office request records, submission keys and the preview

## Context

Roadmap phase 1 adds the guided template "Track an office request". Staff send a form, the office gets a notification and the employee a receipt with a reference. Three questions came up: where the request and its reference live, how a double-click or a phone retry avoids a second request, and how a preview avoids sending anything.

## Options

Request record:

1. A `requests` table with a reference, tied to the owner, the workflow and the run that sends the emails.
2. A step type that writes a record. Every workflow could use it, but the step runs after the run starts, so the form page could not show the reference.

Duplicate submissions:

1. Disable the button with a script. This misses a phone retrying after a timeout, and the hosted form has no script.
2. A submission key per form attempt, unique in the database.

Preview:

1. A mocked test run, as in the builder. It still writes a run and step rows.
2. Work out the record and both emails in the browser with the engine's template resolver.

## Decision

- Record option 1, created only for workflows whose `setup.template` is `office-request`. Other forms behave as before. The table stores the subject and leaves the full submission in the run's trigger payload, so it is stored once.
- Duplicates option 2. `GET /forms/:id` puts a random UUID in a hidden `submission_key` field and sends `Cache-Control: no-store`. `POST` looks the key up, then inserts the run and the request in one transaction. `unique (workflow_id, submission_key)` makes a concurrent duplicate fail, and the API answers it with the first request's reference. The run is queued after commit; the worker's sweep picks up a run whose queueing failed.
- References are `REQ-` plus six random Crockford base32 characters, unique across the database. They are identifiers only: the thank-you page shows the reference, and the request list needs the owner's session.
- Preview option 2 (`previewOfficeRequest()` in `packages/engine/src/office-request.ts`). It makes no API call, so it cannot record or send.
- Setup progress is a `setup` jsonb column on `workflows` (`{ template, step, answers }`). Turning on publishes `officeRequestDefinition(answers)` through the existing versions route, so versions, history and the advanced editor work unchanged.

## Consequences

- A double-click, a retried post and two posts at the same moment give one request and one run. Reloading the form gives a new key, so two intentional requests with the same wording get two references.
- A random reference can collide (about one in a billion per pair). The unique index turns that into a failed submission instead of a shared reference. Lengthen the reference when volume grows.
- Editing a live automation through guided setup, pausing, and marking requests done are left for later roadmap phases.
