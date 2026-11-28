# Deployment: one VM behind a Cloudflare Tunnel

How to run kymavo on a free virtual machine, reached over HTTPS through a free Cloudflare Tunnel. The stack is the same `docker compose up` as on a laptop; only `.env` changes. Nothing has been deployed with this page yet: the restore rehearsal and the exit check below are still to be run on the target.

What it costs: nothing, with one gap. A named tunnel needs a domain whose DNS is on Cloudflare (a Cloudflare account is free and needs no card, a domain usually costs money). Without one, `cloudflared tunnel --url http://localhost:3000` gives a random `trycloudflare.com` address that changes on every restart; it is fine for the exit check and not for a demo link.

## 1. The VM

Recommended: Oracle Cloud Always Free, Ampere A1 shape (arm64), Ubuntu 24.04. One OCPU and 6 GB of memory is plenty; the free allowance is larger.

Fallback: Google Cloud e2-micro (amd64, 1 GB of memory) in a free-tier region. Building the images needs more than 1 GB, so add a 2 GB swap file first:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Both providers ask for a card at signup to verify identity. The free tier is not charged, but this breaks the project's usual "no card" rule, and the owner chose it knowingly.

Two limits to know about. Oracle may reclaim Always Free instances it considers idle. A1 capacity can show "out of capacity" in some regions: try another availability domain, or use the fallback.

No inbound ports need opening: `cloudflared` connects out.

Install Docker Engine and the compose plugin from Docker's apt repository ([instructions](https://docs.docker.com/engine/install/ubuntu/)), then add your user to the docker group (`sudo usermod -aG docker $USER`, log out and in). Then `git clone` the repository to `/srv/daloy` (or `~/daloy`; the paths below use `/srv/daloy`) and copy `.env.example` to `.env`.

The app images were built for linux/arm64 under emulation on 17 November 2026 at `ce6e26c`: both built (api in about 3 minutes, worker in about 1.5 under QEMU), and the api image loaded `@node-rs/argon2` and the worker image ran `tsx` on arm64. That is a build and load check, not a run of the whole stack on arm64.

The browser service (`browser` in docker-compose.yml, decision 0108) is the largest part of the stack. Its base, `mcr.microsoft.com/playwright:v1.65.0-noble`, is about 1 GB to download for arm64 (984 MB of compressed layers, read from the image manifest on 23 November 2026) and 3.65 GB on disk, because it also carries Firefox and WebKit. The built service image is 4.1 GB on disk, so leave at least 6 GB of free disk for it on top of the other images. The image is published for arm64, so it runs natively on the Ampere A1 machine without emulation; so far it was built and run on amd64 only. Memory: the container is limited to 2560 MB (`mem_limit`), sized for `BROWSER_CONCURRENCY=2` jobs of about 1 GB each on heavy pages. A simple page used about 240 MB for the whole container in a check on 23 November 2026. On Oracle's free 4-core, 24 GB A1 machine the defaults fit with room to spare, and they also fit the 6 GB shape suggested above. On the 1 GB e2-micro fallback set `BROWSER_CONCURRENCY=1` and expect only light pages to work, or leave the browser step unused. `BROWSER_TOKEN` must be set in `.env` (`openssl rand -hex 32`) before `docker compose up`, also on an existing installation that pulls this change.

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
# Accounts bring their own AI key. With open, only workspaces with a plan can use LLM_API_KEY.
SHARED_LLM_KEY=off
# Plan a new sign-up starts on. Empty means preview (limited, no shared AI key). none means no limits.
SIGNUP_PLAN=
# For the public demo: the only hosts HTTP steps may call.
HTTP_ALLOWED_HOSTS=<comma list>
```

Without `SMTP_*` values, workflow mail lands in the VM's Mailpit, reachable only over SSH (`ssh -L 8025:localhost:8025 <vm>`). Set a real SMTP server (see `.env.example`) before real sends.

Keep a copy of `SECRETS_KEY` and both passwords outside the machine, apart from the backups (see `docs/operations.md`). Then `docker compose up -d` and, once, `docker compose exec api node_modules/.bin/tsx src/seed.ts` if you want the demo data.

Port 3000 stays bound to 127.0.0.1, as in `docker-compose.yml`. Do not publish it on another interface: with `TRUST_PROXY=1`, a client that reaches the API directly can write its own `X-Forwarded-For` and choose its rate-limit bucket (decision 0035).

## 3. The tunnel

1. In the Cloudflare dashboard, Zero Trust, Networks, Tunnels: create a tunnel, choose Linux, and copy its install command.
2. Run that command on the VM. It installs `cloudflared` as a systemd service that starts with the machine.
3. Add a public hostname for the tunnel with the service `http://localhost:3000`.

`cloudflared` connects out to Cloudflare, so no port is opened on the VM. Cloudflare puts the visitor's address in `X-Forwarded-For` and `cloudflared` is the one hop `TRUST_PROXY=1` counts.

### The admin console at `admin.kymavo.cloud`

The platform admin console has its own hostname (decision 0157), with Cloudflare Access in front and two-factor sign-in for every admin (decision 0158). Once it is set, `/admin` answers 404 on `kymavo.cloud`.

1. In the same tunnel, add a second public hostname: `admin.kymavo.cloud`, service `http://localhost:3000`. Leave "HTTP Host Header" empty, so `cloudflared` passes `admin.kymavo.cloud` on; the API reads the Host header and never `X-Forwarded-Host`.
2. In `.env`, add `ADMIN_HOST=admin.kymavo.cloud` and make sure `PLATFORM_ADMINS` holds your email (create that account first, decision 0137). Then `docker compose up -d api`.
3. In Zero Trust, Access, Applications: add a self-hosted application for `admin.kymavo.cloud`. Add one Allow policy whose rule is Emails, with only your email. Under login methods keep "One-time PIN" on. Visitors then get a PIN by email before any request reaches the VM.
4. Open `https://admin.kymavo.cloud`, pass Access, and sign in with your kymavo email and password. This sign-in is separate from the one on `kymavo.cloud`, since session cookies are host-only.
5. The console asks you to set up two-factor sign-in. Choose Start setup, add the key to an authenticator app (Google Authenticator, 1Password, Aegis and others accept the key or the `otpauth://` link), and enter the 6-digit code. Copy the ten recovery codes into your password manager: they are shown once, and each works once.
6. From then on the console asks for a code at each sign-in and every 12 hours. "Reset 2FA" in the console's navigation turns it off after a fresh code, and the console asks you to set it up again.

After five wrong codes in 15 minutes the console refuses every code for that admin until the 15 minutes pass. Each wrong code is in the audit log.

Lost phone and lost recovery codes: on the VM, reset that admin's two-factor sign-in, then sign in and set it up again.

```bash
cd /srv/daloy
docker compose exec -T postgres psql -U daloy daloy -c "delete from admin_totp where user_id = (select id from users where email = 'you@example.com');"
```

`DELETE 1` means it was reset (the recovery codes go with it); `DELETE 0` means that email had none. It needs shell access to the VM, so nothing on the web can do it.

## 4. Nightly backup to Google Drive

The dump from `docs/operations.md`, written to a temporary name first so a failed dump never replaces a good one, then copied off the VM with [rclone](https://rclone.org) (MIT, installed on the host, not part of the repository). The remote is Google Drive through an rclone `crypt` remote, since the dump holds customer data and encrypted secrets: Drive then holds only ciphertext.

Set up rclone once:

1. Install it on the VM: `sudo apt install rclone`, or the install script from rclone.org.
2. Run `rclone config` and create a remote named `drive`, type Google Drive. The VM has no browser, so answer "n" to auto config. On a PC with a browser run `rclone authorize "drive"`, sign in, and paste the token it prints back into the VM prompt.
3. Create a second remote of type `crypt` named `daloy-backup`, wrapping a folder on the first, for example `drive:daloy-backups`. Let rclone generate the password and the salt.
4. Write the crypt password and salt down outside the VM, next to `SECRETS_KEY`. If you lose them, the dumps cannot be read.

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

Make it executable (`chmod +x`) and create the `backups` folder. Replace `/srv/daloy` with the clone's path. Check the log the next morning and run `rclone ls daloy-backup:` to see the file arrived.

The script does not prune the remote copies. At about 125 kB per dump that is years of space in Google's 15 GB free allowance; delete old ones by hand if needed.

## 5. Restore rehearsal on the target

Once, after the first nightly backup, and again after any change to this page:

1. Copy the newest dump back from the remote: `rclone copy daloy-backup:daloy-<day>.dump /tmp/`.
2. Follow "Restore drill" in `docs/operations.md` on this VM, with a disposable project name and its own ports, so the running stack is untouched.
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

## 7. Owner checklist

The steps only the owner can do, in order:

1. Create the VM (section 1).
2. Install Docker and add your user to the docker group.
3. Clone the repository and fill `.env`: both database passwords, `SECRETS_KEY`, `PUBLIC_URL`, `TRUST_PROXY=1`, `SECURE_COOKIES=true`.
4. Run `docker compose up -d --build` and check `docker compose ps`.
5. Create the tunnel and the public hostname (section 3).
6. Sign in on the console over HTTPS. Then add `admin.kymavo.cloud`, `ADMIN_HOST` and Cloudflare Access, and set up two-factor sign-in (section 3, "The admin console").
7. Set up rclone and the `crypt` remote (section 4).
8. Install `backup.sh` and the cron line.
9. Next morning, check `backups/backup.log` and run `rclone ls daloy-backup:`.
10. Run the restore rehearsal (section 5) and record it in `docs/operations.md`.
11. Run the exit check from two networks (section 6).
12. Record the date, the commit and the results in `PROJECT.md` under N3.

13. Before inviting real accounts, work through section 8.

Store the secrets (`SECRETS_KEY`, both database passwords, the rclone crypt password and salt) in a password manager, never in the repository or in chat.

## 8. Checks before real accounts

The November review asked for these on the real topology. The app side is tested; these parts depend on your proxy and host, so only you can confirm them. Record each result in `PROJECT.md` under N11d.

1. Proxy hops. Section 6 steps 1 and 2 pass from two networks, so `TRUST_PROXY=1` matches the tunnel.
2. Cookie flags. Section 6 step 3: `daloy_session` is Secure, HttpOnly and SameSite=Lax.
3. `Origin` and `Host`. Sign in at the public address and change something (rename an automation). It must work. If every change answers 403, the proxy rewrites `Origin` or `Host`: set `PUBLIC_URL` to the address people type, and make the proxy pass `Origin` unchanged.
4. Sibling sites. No other site on a sibling name of the console host (for example `blog.example.com` next to `daloy.example.com`) may hold content you do not control. Cookies are host-only, but requests from a sibling are same-site. Prefer a separate registrable domain for anything untrusted.
5. Logs. Trello sends its key and token in the query string. Check that Cloudflare, `cloudflared`, Caddy or any outbound proxy does not log full URLs with queries for requests to `api.trello.com`, and that the console host's access log does not keep query strings.
6. Upload memory. The API holds at most 128 MB of in-flight form uploads. Check `docker stats` on the VM during a 5 MB upload test and confirm the API container has room for that plus its normal use. A proxy limit of about 30 MB on `/forms/` request bodies is a good second layer.
7. PayMongo. Run `docs/live-paymongo-check.md` with test keys before turning on real orders: signed test deliveries, event retries, a refund.
8. Release commit. Repeat the review checks on the exact commit you deploy.

## 9. Local model with Ollama (optional)

kymavo can run its own model next to the rest of the stack. On your own computer:

```bash
docker compose --profile local-ai up
```

The `local-ai` profile adds two services. `ollama` (the `ollama/ollama` image, MIT licence, published for amd64 and arm64) keeps its models in the `ollama-models` volume. `ollama-pull` waits until `ollama` answers, runs `ollama pull llama3.2` (about 2 GB), and exits. Later starts find the model in the volume. Then point the api and the worker at it in `.env` and restart them:

```bash
LLM_PROVIDER=ollama
LLM_BASE_URL=http://ollama:11434
LLM_MODEL=llama3.2
```

Use the base without `/v1`: with `LLM_PROVIDER=ollama` kymavo calls Ollama's own `/api/chat`. With `LLM_PROVIDER=openai` the base would be `http://ollama:11434/v1`. llama3.2 reads text only, so leave `LLM_VISION` unset.

Plan on about 4 GB of free memory for llama3.2 (3B). The container runs the model on the CPU; the compose file gives it no GPU. Without the profile, `docker compose up` starts nothing new, and an Ollama running on the host keeps working with the default `LLM_BASE_URL=http://host.docker.internal:11434`. The `ollama` service publishes no port, so it does not clash with a host Ollama on 11434.

On the Oracle Always Free A1 machine this works, but CPU-only answers are slow, and Build with AI with a 3B model often writes drafts that need fixing. A hosted model such as DeepSeek (`deepseek-flash`, see `.env.example`) stays the recommendation there.

## 10. Error reporting and uptime monitoring (optional)

Set `SENTRY_DSN` in `.env` (for example from Sentry.io or a self-hosted GlitchTip project) and `SENTRY_ENVIRONMENT=production` to capture unexpected 5xx exceptions in `api` and unhandled errors in `worker` (`process` handlers, `pg-boss`, sweeps, and delivery pollers). Leave `SENTRY_DSN` empty to disable reporting.

To report uncaught browser errors as well, pass `VITE_SENTRY_DSN` when building `apps/web` and keep `VITE_SENTRY_DSN` in `.env` so the API includes its origin in the console Content Security Policy `connect-src`. The built-in reporter sends minimal scrubbed payloads (query strings and credential keys removed, capped at 20 events per minute) directly to the DSN's `/api/<project>/store/` endpoint without adding a runtime dependency.

Point your external uptime monitor (such as Better Stack, UptimeRobot, or Cloudflare Health Checks) at `GET https://<your hostname>/health`. The route requires no login and checks Postgres with `SELECT 1`, returning `200 {"ok":true}` when healthy or `503` when Postgres is unreachable.
