# 0035: Deployment settings for a stack behind a proxy

## Context

N3 prepares the Compose stack to run on an always-on machine behind a Cloudflare Tunnel. Four things were wrong for that. Rate limits key on `req.ip`, which behind any proxy is the proxy, so every visitor shared one bucket. The session cookie was Secure only with `NODE_ENV=production`, which compose never set. Accounts without their own AI settings, and the "Local model" choice, sent the operator's `LLM_API_KEY`. The database passwords defaulted to `daloy` and `daloy_app`.

## Options

- Proxy: Express `trust proxy` set to `true`, to a list of proxy addresses, or to a hop count.
- Cookies: set `NODE_ENV=production` in compose, or add `SECURE_COOKIES`.
- AI key: drop the env key for accounts without settings only, or gate every use of it behind a variable.
- Passwords: new defaults in compose, or no defaults at all.

## Decision

- `TRUST_PROXY` is a hop count (0 to 10, default 0). `true` would let a client choose its own address by writing `X-Forwarded-For`; a list of addresses breaks when the tunnel's address changes. With one hop Express takes the rightmost entry, the one the proxy wrote.
- `SECURE_COOKIES=true|false`. `NODE_ENV=production` would also flip `SHARED_MAIL` to approved and so change local Mailpit behaviour, so it stays a separate switch; `NODE_ENV=production` still forces Secure.
- `deployEnv()` refuses unreadable values for both, so a typo stops the boot.
- `SHARED_LLM_KEY=open|off`, default off, covers both the no-settings path and "Local model", since dropping the key from only one leaves the other as a way around it.
- `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` are required, like `SECRETS_KEY`.
- Sign-up gets its own limit, 10 per IP per hour, set by `REGISTER_LIMIT_PER_HOUR`; the test suites raise it because all their accounts come from 127.0.0.1.
- `HTTP_ALLOWED_HOSTS` optionally limits HTTP steps to listed hosts, for the public demo.

## Consequences

- Port 3000 must only be reachable through the proxy. Compose binds it to 127.0.0.1; if it is ever published on a public interface with `TRUST_PROXY=1`, clients can pick their bucket.
- An installation whose accounts relied on the env key (a local llama.cpp with `--api-key`, or Gemini set in `.env`) needs `SHARED_LLM_KEY=open`, or each account saves its own key.
- An existing `.env` without both passwords stops `docker compose up` until they are added. Postgres reads them only when the volume is created, so they must match what the volume already has.
- Rate-limit counters are still per API process.
