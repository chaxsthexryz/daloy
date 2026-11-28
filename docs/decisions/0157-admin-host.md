# 0157. The admin console on its own hostname

## Status

Accepted

## Context

Decision 0152 put the platform admin console at `/admin` on the same host as the workspace console. The owner chose to serve it at `admin.kymavo.cloud` before launch, so Cloudflare Access can stand in front of that host alone and a session on the main site never reaches the admin. Production runs on one VM behind a Cloudflare Tunnel (`docs/deployment.md`), so both hostnames reach the same API on `localhost:3000`.

## Options

- A second API process or container for the admin. It doubles the stack on a small VM for a handful of routes.
- A `Domain=kymavo.cloud` cookie shared by both hosts. One sign-in would then reach both, which is what we want to avoid.
- One API that routes by the Host header, with the admin host given by an env var.

## Decision

`ADMIN_HOST` (optional, for example `admin.kymavo.cloud`) names the admin host. Unset, in dev and tests, `/admin` works as in 0152.

When it is set (`adminHostRouting` in `apps/api/src/admin-page.ts`, run around static serving in `createApp`):

- On the admin host, `/` and `/index.html` are the admin page, the static files (its assets) are served, and only `/admin`, `/admin/*`, `/auth/login`, `/auth/logout` and `/auth/me` reach the API. Everything else, the workspace console and API, public forms and webhooks included, answers 404. The allowlist is matched exactly, case included.
- On every other host, any path that starts with `/admin` (any case, extra slashes, and `admin.html` after `hideAdminHtml`) answers 404 before routing. `platformAdmin()` in `apps/api/src/admin.ts`, which every admin guard runs, also answers 404 off the admin host, so a spelling the middleware misses still finds nothing.
- The admin page on its own host loads for anyone, because it is also the sign-in for that host. It holds no data: every admin route still needs a platform admin with a passed two-factor check (decision 0158), and Cloudflare Access is in front. Off `ADMIN_HOST` the page still needs an admin session, as in 0152.
- Admin changes must carry `Origin: https://<ADMIN_HOST>`, exactly. A missing Origin, `http://`, the main site and any other origin get 403. Without `ADMIN_HOST` the old `fromOwnOrigin` rule stays.
- The host comes from the `Host` header only (`requestHost` in `apps/api/src/http.ts`), lowercased and without the port. `X-Forwarded-Host` is never read: Express would trust it under `trust proxy`, and a client behind Cloudflare can write it. `cloudflared` passes the visitor's Host on unchanged. `TRUST_PROXY=1` still decides `req.ip` and `req.protocol` as before.
- Session cookies stay host-only (no `Domain`), so the browser sends a session made on one host only to that host. The admin signs in on the admin host separately.
- `/auth/me` and sign-in add `adminUrl` for a platform admin, so the workspace console's old `#/admin` sends them to the admin host. The console's "Open the workspace console" link uses `PUBLIC_URL` there.

## Consequences

- The owner adds the hostname to the tunnel and sets `ADMIN_HOST`; both steps are in `docs/deployment.md` section 3.
- With `ADMIN_HOST` set, `/admin` disappears from the main site, including for admins.
- The admin JavaScript is reachable on the admin host without a session, as the workspace bundle already is on the main site. It holds no data.
- A request that reaches port 3000 directly with a forged Host could pick the admin host, so port 3000 must stay bound to 127.0.0.1 (as section 2 of the deployment page already says). The admin routes still need the admin's session and two-factor check.
