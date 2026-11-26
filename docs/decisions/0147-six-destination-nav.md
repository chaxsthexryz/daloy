# 0147. Six-destination navigation and tab consolidation

## Status

Accepted

## Context

By the end of F6 the console sidebar held 12 visible destinations across Work, Build and Workspace plus 6 hidden or secondary routes (Resources, Secrets, Tokens, AI model, Ask about a request, Advanced), duplicated links in the Help menu and a redundant top-bar New button. Meanwhile, Lalamove required visiting developer Secrets even though every other integration lives on Apps, and Resources lived apart from Bookings.

## Decision

Collapse the console navigation to six destinations for owners (`Home`, `Inbox`, `Bookings`, `Automations`, `Business`, `Settings`), four for operators (`Home`, `Inbox`, `Bookings`, `Settings`), and two for approvers/requesters (`Home`, `Settings`), while preserving all legacy hash routes as in-place aliases:

1. **Bookings (`#/bookings`)** adds a `Rooms and slots` tab (`#/bookings?tab=rooms`, alias `#/resources`) for owners alongside `Calendar`.
2. **Business (`#/business`)** combines four tabs: `Details and branding` (`#/settings/business`), `Knowledge` (`#/knowledge`), `Apps` (`#/apps`), and `Team` (`#/team`). Lalamove is promoted to a first-class app card inside Apps, backed by encrypted `lalamove_api_key` and `lalamove_api_secret` secrets without sending owners to Secrets.
3. **New picker (`#/new`, `#/ai`)** merges `Templates` and `Build with AI` into one tabbed screen reached from the single `New` button on Automations, placing `Blank automation` in a quiet footer below templates.
4. **Settings > Advanced** surfaces `Secrets`, `All automations`, and admin-only links (`API tokens`, `AI model`, `Platform tools`) to owners/admins while hiding Secrets from Apps.
5. **Activity search (`#/activity`)** embeds `Ask about a request` directly alongside search filters, keeping `#/activity/ask` and `#/runs/:id/ask` working as deep links.
6. **Readiness links** updated in `apps/api/src/readiness.ts` to point directly into the consolidated Business and Bookings tabs (`#/business?tab=apps`, `#/business?tab=apps&app=lalamove`, `#/bookings?tab=rooms`, `#/business?tab=knowledge`, `#/business?tab=team`).

## Consequences

- Owners see six clean sidebar destinations on desktop and a four-button bar on 390x844 mobile (`Home`, `Inbox`, `Automations`, `Menu`).
- All existing bookmarks, OAuth callbacks (`#/apps/<slug>-<outcome>`, `#/settings/business/outlook-<outcome>`), and email deep links keep working without broken links.
