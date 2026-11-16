# Deployment: one machine behind a Cloudflare Tunnel

How to run Daloy on an always-on machine you control, reached over HTTPS through a free Cloudflare Tunnel. The stack is the same `docker compose up` as on a laptop; only `.env` changes. Nothing has been deployed with this page yet: the restore rehearsal and the exit check below are still to be run on the target.

What it costs: nothing, with one gap. A named tunnel needs a domain whose DNS is on Cloudflare (a Cloudflare account is free and needs no card, a domain usually costs money). Without one, `cloudflared tunnel --url http://localhost:3000` gives a random `trycloudflare.com` address that changes on every restart; it is fine for the exit check and not for a demo link.

## 1. The machine

Docker with Compose, `git`, and about 2 GB of free memory. Clone the repository and copy `.env.example` to `.env`.

## 2. `.env` for this deployment

Fill in, beside the values `.env.example` asks for:

```bash
POSTGRES_PASSWORD=<openssl rand -hex 24>
APP_DB_PASSWORD=<openssl rand -hex 24>
SECRETS_KEY=<openssl rand -base64 32>
PUBLIC_URL=https://<your hostname>
# One proxy (cloudflared) in front of the API.
TRUST_PROXY=1
SECURE_COOKIES=true
# Only the owner's approved workspaces may send through the installation's SMTP server.
SHARED_MAIL=approved
# Accounts bring their own AI key.
SHARED_LLM_KEY=off
# For the public demo: the only hosts HTTP steps may call.
HTTP_ALLOWED_HOSTS=<comma list>
```

Keep a copy of `SECRETS_KEY` and both passwords outside the machine, apart from the backups (see `docs/operations.md`). Then `docker compose up -d` and, once, `docker compose exec api node_modules/.bin/tsx src/seed.ts` if you want the demo data.

Port 3000 stays bound to 127.0.0.1, as in `docker-compose.yml`. Do not publish it on another interface: with `TRUST_PROXY=1`, a client that reaches the API directly can write its own `X-Forwarded-For` and choose its rate-limit bucket (decision 0035).

## 3. The tunnel

1. In the Cloudflare dashboard, Zero Trust, Networks, Tunnels: create a tunnel and copy its install command.
2. Run that command on the machine. It installs `cloudflared` as a service that starts with the machine.
3. Add a public hostname for the tunnel with the service `http://localhost:3000`.

`cloudflared` connects out to Cloudflare, so no port is opened on the router. Cloudflare puts the visitor's address in `X-Forwarded-For` and `cloudflared` is the one hop `TRUST_PROXY=1` counts.

## 4. Nightly backup to another machine

The dump from `docs/operations.md`, written to a temporary name first so a failed dump never replaces a good one, then copied off the machine with [rclone](https://rclone.org) (MIT, installed on the host, not part of the repository). A free cloud drive works as the remote; make it an rclone `crypt` remote, since the dump holds customer data and encrypted secrets.

`/srv/daloy/backup.sh`, run by cron at 02:00 (`0 2 * * * /srv/daloy/backup.sh >> /srv/daloy/backups/backup.log 2>&1`):

```bash
#!/bin/sh
set -eu
cd /srv/daloy
day=$(date +%Y%m%d)
docker compose exec -T postgres pg_dump -U daloy -Fc daloy > backups/daloy-$day.dump.tmp
mv backups/daloy-$day.dump.tmp backups/daloy-$day.dump
rclone copy backups/daloy-$day.dump daloy-backup:
find backups -name 'daloy-*.dump' -mtime +14 -delete
```

Replace `/srv/daloy` with the clone's path and `daloy-backup:` with your remote. Check the log the next morning and run `rclone ls daloy-backup:` to see the file arrived.

## 5. Restore rehearsal on the target

Once, after the first nightly backup, and again after any change to this page:

1. Copy the newest dump back from the remote: `rclone copy daloy-backup:daloy-<day>.dump /tmp/`.
2. Follow "Restore drill" in `docs/operations.md` on this machine, with a disposable project name and its own ports, so the running stack is untouched.
3. Record the date, the commit, the dump's size, and the counts you compared, under "Restore drill" in `docs/operations.md`.

## 6. Exit check

From two different networks (for example home Wi-Fi and a phone on mobile data):

1. On network A, eleven wrong logins: ten answers of 401, then 429.

   ```bash
   for i in $(seq 11); do curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<host>/auth/login -H 'content-type: application/json' -d '{"email":"nobody@example.com","password":"wrong"}'; done
   ```

2. Right after, on network B, the same request once: 401, not 429. A 429 means every client shares one bucket, so `TRUST_PROXY` is wrong for this setup.
3. Sign in on the console and check the `daloy_session` cookie in the browser's developer tools: Secure, HttpOnly, SameSite=Lax.

Record the result and the commit in `PROJECT.md` under N3.
