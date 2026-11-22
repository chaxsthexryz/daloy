# 0101. Migration timestamps must increase

## Context

Drizzle's migrator reads the newest `created_at` the database has recorded, and applies a migration only when the journal's `when` for it is later. It does not compare hashes or look for gaps.

Branches built in parallel generated migrations at different times. Two migrations also had hand-picked round timestamps: 0037 (`1795100000000`) and 0043 (`1795400000000`). After merging, 0035, 0036, 0038, 0039, 0044 and 0045 each had a `when` older than an entry before them.

A fresh database applies every migration in one pass, so CI and the e2e suite never noticed. A database upgraded one step at a time skipped those migrations for good. The owner's local stack, for example, had 0043 recorded and was missing 0035, 0036, 0044 and 0045, so sign-in failed on the missing `users.digest_enabled` column.

## Options

1. Lower the out-of-order high timestamps (0034, 0037, 0043). Databases that recorded the old high values would then skip even more migrations.
2. Write a custom migrator that applies by hash. This fixes the class of bug, but replaces a library function with code we must keep correct.
3. Raise each out-of-order `when` just above its predecessor, and make those six migrations safe to re-run. Add a final repair migration that re-applies whatever an upgraded database skipped, plus a test that fails on any out-of-order journal entry.

## Decision

Option 3.

The six moved migrations now use `IF NOT EXISTS`, `DROP ... IF EXISTS`, or a `DO` block that checks `pg_constraint`. A database that had already applied them can replay them safely.

`0046_repair_skipped_migrations` has the latest timestamp. It re-asserts the still-current effects of 0035, 0036, 0039, 0044 and 0045. It leaves 0038 alone, because 0040 and 0041 redefine that constraint later. On a healthy database it changes nothing.

`packages/db/src/migrations.test.ts` fails when a journal entry's `when` is not later than the one before it.

## Consequences

- A merge that brings in a migration with an older timestamp now fails the unit tests. Fix it by raising that entry's `when` above the previous one, never by lowering an earlier one.
- Every database, fresh or upgraded, ends up with the same schema after the next boot.
- The SQL of six applied migrations changed. Drizzle does not check hashes, so nothing re-runs because of that alone.
