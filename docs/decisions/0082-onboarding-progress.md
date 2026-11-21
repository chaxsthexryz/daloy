# 0082. Onboarding progress: one row per workspace, the profile and brand stay where they are

## Context

Roadmap phase R1 asks a new owner three questions (business identity, business type, first workflow and payment) and must save after each one, so a closed tab or "Save and close" resumes at the next screen. The workspace already has a business profile (name, website, inbox, reply-to) and a brand kit (logo, accent). Existing owners must keep their settings.

## Options

1. Store every answer in a new table, copying the name and website. Two places hold the business name and they drift.
2. Keep the name and website in `business_profiles`, the logo in the brand kit, and add one `onboarding_progress` row for the answers that exist nowhere else (categories, goal, payment, the draft's id).
3. Keep progress in the browser. A second device or a cleared browser loses it.

## Decision

Option 2. `PUT /onboarding/identity` writes the name and website through `saveProfile` and keeps the inbox and reply-to address as they are. The logo uses the existing `PUT /settings/brand/logo`. `onboarding_progress` (migration 0042) holds `status` (in_progress, completed, dismissed), `completed` (screens saved, 0 to 3), the categories, the goal, the payment, `workflow_id` and the sample order.

Screens save in order: screen n needs screen n minus 1, or the API answers 409. Saving an earlier screen again keeps the count, so editing the name never forgets the later answers. The screen to open is the first one after `completed`, and the last screen once all three are saved. A booking goal drops any payment answer.

Migration 0042 inserts a `dismissed` row for every existing user. Only a workspace with no row is new, so existing owners see no prompt and no setting of theirs changes. They can still open `#/onboarding`; saving a screen there turns the row into `in_progress`.

## Consequences

- The business name has one home. Business settings and onboarding show the same value.
- A dismissed row is the marker for "existed before onboarding" and also for "Not now". Both mean the same thing: do not prompt.
- Deleting a user deletes the row (cascade). Deleting the draft sets `workflow_id` to null, so the next finish makes a new draft.
- Tests: `packages/engine/src/onboarding.test.ts` (rules), `apps/api/src/onboarding.test.ts` (routes), `apps/web/src/lib/onboarding.test.ts` (screens), `e2e/onboarding.spec.ts`.
