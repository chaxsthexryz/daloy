# 0043: Tagalog is a workspace setting stored on the owner

## Context

N8 asks for Tagalog string tables for the console and emails, Taglish copy, and the owner picks the language. English stays the default.

## Options

- A per-browser setting, like the theme.
- A per-user setting for every member.
- One setting for the workspace, held on the owner's `users` row.

## Decision

One setting per workspace: `users.language` (`en` or `tl`, migration 0024) on the owner, whose id is the workspace id. Settings lets the owner change it; every member then sees the same language, and emails (test email, approvals, notices, AI reword) follow it, because an email has no browser to ask. The console looks strings up by their English text, so a missing Tagalog entry falls back to English instead of showing a key.

## Consequences

Members cannot choose their own language yet. Adding one means a column on each member. Terms follow the N4 vocabulary table (automation, approval, booking stay as the owners already say them).
