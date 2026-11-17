# 0036: Reference n8n for console navigation

## Context

N4 named the Zapier linear editor and the Activepieces builder as references for the console. After N4 and V2 the owner still found the console hard to navigate and asked for it to feel like n8n, with a separate AI tab that asks a few questions before it drafts an automation. A walkthrough on 17 November 2026 found the create button buried below every card, duplicate drafts, broken desktop tables, two places to look for a request and mixed words for the same thing ([docs/console-navigation-plan.md](../console-navigation-plan.md)).

## Options

- Keep Zapier and Activepieces as the reference.
- Follow n8n's navigation layout.
- Design without a reference.

## Decision

Follow n8n's navigation layout: a create button that is always visible, one activity list across all automations with a state filter, a switch on each automation between its steps and its activity, and an AI builder whose draft is reviewed before anything saves. n8n is under the Sustainable Use License, so its public docs and screens are studied only. No code, icons, text or assets are copied. Daloy keeps its own words, its own components and a phone-first layout (a bottom bar on phones).

## Consequences

- N4d, N4e and N4f in `PROJECT.md` carry the work and replace the Zapier and Activepieces reference.
- Canvas-first editing, credentials as a menu item, projects and variables are not adopted. On a phone the steps show as a list.
- The AI tab asks fixed questions on the page (no model call), sends no customer data, run data or team addresses to the model, and saves nothing before Save as draft. These rules are stricter than n8n's builder, which needs real data values sent.
- Before N6 the tab uses only the workspace's own model. `SHARED_LLM_KEY` stays closed on public and pilot installations until N6 adds a per-workspace AI quota (decision 0035).
