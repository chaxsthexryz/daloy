# Deployment: one VM behind a Cloudflare Tunnel

How to run Daloy on a free virtual machine, reached over HTTPS through a free Cloudflare Tunnel. The stack is the same `docker compose up` as on a laptop; only `.env` changes. Nothing has been deployed with this page yet: the restore rehearsal and the exit check below are still to be run on the target.

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
6. Sign in on the console over HTTPS.
7. Set up rclone and the `crypt` remote (section 4).
8. Install `backup.sh` and the cron line.
9. Next morning, check `backups/backup.log` and run `rclone ls daloy-backup:`.
10. Run the restore rehearsal (section 5) and record it in `docs/operations.md`.
11. Run the exit check from two networks (section 6).
12. Record the date, the commit and the results in `PROJECT.md` under N3.

Store the secrets (`SECRETS_KEY`, both database passwords, the rclone crypt password and salt) in a password manager, never in the repository or in chat.
