# Operations: backup, restore, stopping sends, upgrades and monitoring

How to run the Compose stack day to day. Each procedure below was tried once on a disposable Compose project; the result is recorded under it. Commands assume the repository root and the default project name. On another project, add `-p <name>` (and the same `-f` and `--env-file` flags you started it with) to every `docker compose` command, and never run `docker compose down -v` without `-p`, because it deletes that project's database volume.

## Backup

```bash
docker compose exec -T postgres pg_dump -U daloy -Fc daloy > daloy-$(date +%Y%m%d).dump
```

- `-Fc` is Postgres's compressed custom format, which `pg_restore` reads. The dump holds the app tables, the `drizzle` migration history and the `pgboss` queue schema, so waiting runs and scheduled jobs come back with it.
- Keep the `SECRETS_KEY` from `.env` with the backup, stored separately. Saved keys, connection tokens and Gmail app passwords are encrypted with it, so a restore under a different key keeps the rows but cannot decrypt them.
- The dump contains customer data and encrypted secrets. Store it where only the owner can read it.
- Use the values from `.env` if `POSTGRES_USER` or `POSTGRES_DB` is not `daloy`.

## Restore

Restore into a stack whose Postgres volume is new, so the init script has already created the `daloy_app` role the dump grants rights to.

```bash
docker compose down            # stop the old stack (add -v only if you mean to delete its volume)
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U daloy -d daloy --clean --if-exists < daloy-YYYYMMDD.dump
docker compose up -d --wait
```

`migrate` then finds every migration in the restored history and changes nothing. The API can take a few seconds after `--wait` returns before it answers. Sign in and open Runs to check.

### Restore drill

Tried at `61757dd` on the disposable project `daloy-n3check` (override file remapping the host ports to 53100, 55532, 51125 and 58125, its own volume, an env file with a throwaway `SECRETS_KEY`, no `.env`, so mail went to Mailpit). The seed ran, two more workflows were published (a webhook that emails Mailpit, and one that fails on an invalid address), and the stop sends drill below ran first.

| Check | Before backup | After restore |
| --- | --- | --- |
| users, workflows, versions | 1, 7, 7 | 1, 7, 7 |
| runs, step runs | 10, 21 | 10, 21 |
| applied migrations | 20 | 20 |

The dump was 125 kB. `docker compose down -v` deleted the volume, `postgres` started on a new one, `pg_restore` exited 0 and the full stack came up with `migrate` exiting 0. The demo login returned 200, Runs listed all 10 runs including the failed one, and a webhook to the drill workflow's path from before the backup was sent to Mailpit, so the queue schema and the `daloy_app` grants came back too. Not checked: decrypting a saved secret after restore (the drill had none). The project, its volume, its images and the throwaway key were removed afterwards.

## Stopping all sends

Every workflow send (email, HTTP, Sheets, Slack, Outlook, Teams) happens in the worker. The API sends one thing itself, the "Send a test email to me" button, and only when a signed-in person clicks it. To stop all sends:

```bash
docker compose stop worker
```

The worker gets 30 seconds to finish the step it is on (`stop_grace_period` is 40 s). While it is stopped, triggers still accept runs (the drill used webhooks) and the runs wait in the queue as `pending` without sending. `docker compose start worker` picks them up again.

Limits:

- There is no switch to turn one workflow off. Deleting a workflow removes its run history.
- Starting the worker again sends the whole backlog, and the console has no button to cancel a pending run. The only way to drop the backlog today is to restore a backup taken before the problem.

### Stop sends drill

Same project, before the backup. One webhook was sent first (Mailpit total 1). Then:

1. `docker compose stop worker` returned in under a second, since the worker was idle.
2. Three webhook posts each got 202. Ten seconds later the drill workflow had 3 runs `pending` and 1 `succeeded`, and Mailpit still held 1 message.
3. `docker compose start worker` (Compose reran `migrate` first, which changed nothing). Within a few seconds Mailpit held 4 messages and all 4 runs were `succeeded`.

## Upgrading

`migrate` applies new migrations on `docker compose up`. Take a backup first. `apps/api/src/upgrade.test.ts` checks two upgrades on a database that already holds data: 0008 to 0009 (workspace members) and 0018 to 0019, the newest (bookings). The second keeps a workspace's runs, including a failed one with its error, and its resources readable through the API, and the new booking tables reject an overlapping booking on the upgraded database.

## Monitoring failed and needs_review runs

There is no alert. Check once a day, and after any provider outage:

1. Runs page, "Needs review" filter. It lists runs in `needs_review` and runs with a Sheets, Slack, Outlook or Teams delivery waiting for a decision. A run's detail page asks whether the send went through, with "It went through", "Send again" and "Stop".
2. Runs page, "All": the "Needs review" filter does not list `failed` runs. Their badge is red and the detail page shows the error and a Retry button for once the cause is fixed.
3. The same from the database, read only, for the last 24 hours:

```bash
docker compose exec -T postgres psql -U daloy -d daloy -c "select w.name, r.state, count(*), max(r.created_at) as latest from runs r join workflow_versions v on v.id = r.workflow_version_id join workflows w on w.id = v.workflow_id where not r.test and r.state in ('failed', 'needs_review') and r.created_at > now() - interval '1 day' group by 1, 2 order by 4 desc"
```

Tried on the drill project: after the run with an invalid address failed, the query listed `Drill fail | failed | 1`, while the API behind the "Needs review" filter (`/runs?review=true`) returned no runs.

Any row means someone should look. A workflow that keeps failing the same way can be stopped with the procedure above while it is fixed.

## Plans, usage and invoicing

Limits come from a workspace's plan (decision 0038). `pilot`, `business` and `business_plus` are the only values. Only you can set one, with SQL. A workspace with no plan has no limits and cannot use the shared AI key.

The platform admin page (`#/admin`, decision 0122) sets plans and shared mail approval for the accounts listed in `PLATFORM_ADMINS`, and records each change. The SQL below does the same thing without the record.

Set a plan and the date its monthly cycle starts. The AI count resets on that day each month, Manila time:

```bash
docker compose exec postgres psql -U daloy -d daloy -c "update users set plan = 'business', plan_started_on = '2026-12-01' where email = 'owner@example.com'"
```

Remove a plan with `plan = null`. The limits go away, usage is still counted, and the shared AI key stops working for that workspace.

Read a workspace's use. `period` is the Manila day for `email` and `http`, and the cycle's start date for `ai`:

```bash
docker compose exec postgres psql -U daloy -d daloy -c "select c.kind, c.period, c.used from usage_counts c join users u on u.id = c.user_id where u.email = 'owner@example.com' order by c.kind, c.period desc limit 10"
```

The owner sees the same numbers in Settings, under Plan and usage. When a workspace hits a limit the run stops at that step and nothing is sent. The owner presses Retry after the reset, or after you change the plan.

### Monthly invoice (GCash or Maya)

Payment is by hand. kymavo has no payment code for its own subscription. The PayMongo step and trigger ([decision 0045](decisions/0045-paymongo-payments.md), [live check](live-paymongo-check.md)) are for an owner's customers, not for billing the owner. Keep a ledger, for example a spreadsheet with one row per payment: date, workspace email, plan, amount, reference.

1. On each workspace's plan start date, send an invoice. State the amount, $10 a month for Business or $25 for Business Plus (Pilot is free), in pesos at that day's rate, or a fixed peso price you have written down. Add your GCash or Maya number and a reference such as `DALOY-<workspace>-<YYYYMM>`.
2. When the customer says they paid, find the payment in the GCash or Maya app and match its reference and amount.
3. Add the row to the ledger.
4. If it is still unpaid after 7 days, move the workspace to Pilot:

```bash
docker compose exec postgres psql -U daloy -d daloy -c "update users set plan = 'pilot' where email = 'owner@example.com'"
```

Nothing is deleted. Live automations above the Pilot limit keep running, but no new ones can be published. Set the plan back when the payment arrives.

## Deployment target

Chosen in N3: a free VM (Oracle Always Free Ampere A1, or Google Cloud e2-micro), running this same `docker compose up`, behind a Cloudflare Tunnel, with nightly dumps to Google Drive through an rclone `crypt` remote. [docs/deployment.md](deployment.md) has the setup, the backup and the restore rehearsal. Nothing is deployed yet. The options that were weighed:

1. An owner-run machine at home and a Cloudflare Tunnel. No card, no code changes. Uptime depends on that machine.
2. Render's free web service with Neon's free Postgres. Free web services sleep when idle and background workers are not on the free plan, so the worker would have to run inside the API process and schedules would pause while it sleeps. That needs code changes.
3. The free VM (chosen). No code changes, always on, and every procedure in this file works as written. The provider asks for a card at signup to verify identity; the free tier is not charged.
