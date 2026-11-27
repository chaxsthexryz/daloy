# 0152. Admin console as its own page at /admin

## Status

Accepted

## Context

The platform admin page (decision 0122) was a hash route, `#/admin`, inside the workspace console. It shared the console's sidebar, header and breadcrumbs, and every admin feature (shared AI model in A2, feedback inbox in A4) would have grown that page further. The owner asked for the admin to be a different page, not built into the app. A later step may serve it at `admin.kymavo.cloud` through Cloudflare.

The admin API already lives at `/admin/<name>` (`/admin/overview`, `/admin/runs`, `/admin/ai`, `/admin/feedback`, ...). The API serves the built web console as static files from `WEB_DIST`.

## Options

1. Keep `#/admin` and give it its own layout. Simple, but the page is still part of the workspace bundle and its existence is visible to anyone who reads that bundle.
2. A second Vite entry, `admin.html`, served by the API at `/admin` with path routes for tabs (`/admin/runs`) and an SPA fallback. Path tabs collide with the admin API, which already owns every `/admin/<name>` path.
3. A second Vite entry served only at `/admin`, with hash routes for tabs (`/admin#/runs?state=failed`), the same way the workspace console uses hash routes.

## Decision

Option 3.

- `apps/web/admin.html` and `src/admin-main.tsx` are a separate entry with its own shell (`AdminShell` in `Admin.tsx`): a narrow navigation with Overview, Workspaces, Runs, AI models, Feedback and Audit log, the signed-in email, a link to the workspace console at `/` and Sign out. It does not render the workspace sidebar, and the workspace console has no link to it.
- `AdminPageController` (`apps/api/src/admin-page.ts`) answers `GET /admin` (and `/admin/`) behind the same `AdminGuard` as the admin API, so a signed-out visitor or an account outside `PLATFORM_ADMINS` gets the exact 404 body the admin API gives. The page is sent with `Cache-Control: no-store`, because access depends on the session cookie and a shared cache must not keep a copy.
- Static serving moved from `main.ts` into `createApp` (`webDist`, from `WEB_DIST`) so tests cover it. `hideAdminHtml` rewrites any request whose decoded path names `admin.html` (any case, percent-encoded, or behind `..`) to `/admin` before the static file server sees it, so the file is only ever handed out by the guarded route.
- Tabs are hash routes read by `adminRoute()` in `lib/admin-route.ts`; an unknown tab opens the overview. No SPA fallback is needed because `/admin` is the only path.
- `#/admin` in the workspace console sends a platform admin to `/admin` and shows the ordinary "Page not found" to everyone else.
- In `pnpm dev`, Vite serves the console at `/admin.html` and proxies `^/admin/` (a pattern, so `/admin.html` stays with Vite) to the API.

## Consequences

- The admin console's JavaScript chunk sits in `dist/assets` with the rest and is publicly fetchable by its hashed name. It holds only interface code; every piece of data comes from the guarded API. The chunk name is only listed in `admin.html`, which non-admins cannot get.
- Serving it at `admin.kymavo.cloud` later needs only a Cloudflare route to the same API: the session cookie, `PLATFORM_ADMINS` and the Origin check work the same. A separate host would also need its own `PUBLIC_URL` origin to be accepted by the Origin check.
- A tab whose API is not on main can be left out of `SHOWN_TABS` in `Admin.tsx`; its hash then opens the overview.
- Still due before launch: TOTP two-factor sign-in for platform admins. A stolen admin session can read every workspace's counts and change plans and the shared AI model.
