# 0116. Knowledge sheet and published versions

## Context

The resort concierge (plan `docs/plans/resort-concierge.md`) answers guests only from text the owner wrote. Prices must never come from the model, so the owner's text needs one trusted source that can be versioned: C4's reply guard checks every figure in an answer against the entries the answer cites. The resort has not said how its rates work (season, weekday, per head, day-tour or entrance fees, fixed or percent deposit), so the rate fields must not assume one shape.

## Options

1. A Google Sheet the bot reads. Needs a new read scope, and the owner could change a price while a guest is mid-conversation.
2. One table of live rows. Simple, but an edit is live at once and an answer cannot say which text it used.
3. Draft rows plus immutable published copies, as workflow versions work.

## Decision

Option 3.

- `knowledge_entries` holds draft rows: kind, title, text and a `fields` JSON. Kinds: room, rate, fee, faq, policy, location, activity, arrival, review_link.
- `knowledge_versions` holds one row per publish: a version number per workspace (unique with the workspace) and the full entry list as JSON, with each draft's id kept so an answer can cite it. A database trigger refuses any UPDATE, so no code path can edit a published copy. The version in use is the highest one; there is no rollback pointer yet, because restoring an old version is "edit the drafts, publish again".
- Publish is refused when there are no entries or nothing changed since the version in use, and it runs under a per-workspace advisory lock so two publishes cannot take the same number.
- Rates are a base price plus optional named rules, so no shape is guessed. `fields` takes: `price` (whole pesos), `unit` (night, person, person_night, stay, day), `capacity`, `deposit` (`fixed` pesos or `percent` 1 to 100), `url` (https only) and up to 12 `rules`. A rule has a name, a price, an optional unit, an optional season as `MM-DD` to `MM-DD` (it may wrap the new year) and optional weekdays. Price fields are only accepted on room, rate and fee entries. Which rule wins when several match is for `stay_quote` in C4 to decide; C3 stores them in the order written.
- Prices are whole pesos. Centavo rates are not supported; a resort that needs them is a later change.
- The page and routes are for the owner and the operator. Approvers and requesters get 403.
- The tables hold the resort's own business text, not guest data, so they are not added to `collect()`, `deleteCustomer()` or `keptOf()` in `privacy.ts`. If an owner types a guest's name into an entry, R6 does not find it.
- At most 200 entries per workspace, 2,000 characters of text per entry.

## Consequences

- An edit never reaches a guest until Publish, and the page says when drafts differ from the live version.
- Deleting a draft does not remove it from versions already published, which is what lets an old answer stay explainable.
- C4 reads `readKnowledge(db, workspaceId)` and cites entry ids from that copy.
- Two applied migrations with the same drizzle snapshot parent (this one and C1's 0049) need a rebase on merge, as the plan already notes.
