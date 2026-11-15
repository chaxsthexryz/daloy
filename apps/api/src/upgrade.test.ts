import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { encryptSecret, hashToken, migrate, readSecret, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

// Roadmap phase 4 upgrade: a database at migration 0008 with an owner, a workflow, a run, a saved key and an approval
// link already in someone's inbox. After 0009 the owner still signs in and owns everything, and the old link still
// works the way it did when it was sent (decision 0022).

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
const key = randomBytes(32);
const PASSWORD = "correct horse battery";
const token = randomBytes(32).toString("base64url");
let ownerId: string;
let workflowId: string;

/** Applies migrations 0000 to `last` only, from a copy of the folder with a trimmed journal. */
async function migrateUpTo(p: Pool, last: number) {
  const source = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "daloy-migrations-"));
  cpSync(source, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= last);
  writeFileSync(journalPath, JSON.stringify(journal));
  await runMigrations(drizzle(p), { migrationsFolder: dir });
  rmSync(dir, { recursive: true, force: true });
}

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase({ migrated: false }));
  await migrateUpTo(pool, 8);
  // Raw SQL: the current Drizzle schema has columns that 0008 doesn't.
  const q = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0] as { id: string };
  ownerId = (await q("insert into users (email, password_hash) values ($1, $2) returning id", ["old.owner@test.local", await hash(PASSWORD)])).id;
  workflowId = (await q("insert into workflows (user_id, name, slug) values ($1, 'Refunds', 'refunds') returning id", [ownerId])).id;
  const versionId = (await q("insert into workflow_versions (workflow_id, version, definition, published) values ($1, 1, '{}', true) returning id", [workflowId])).id;
  const runId = (await q("insert into runs (workflow_version_id, state, next_attempt_at) values ($1, 'waiting', now() + interval '1 hour') returning id", [versionId])).id;
  const stepRunId = (await q("insert into step_runs (run_id, step_id, attempt, state, input) values ($1, 'ask', 1, 'waiting', $2) returning id", [runId, { message: "Refund 40 EUR?" }])).id;
  await q("insert into approvals (step_run_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour') returning id", [stepRunId, hashToken(token)]);
  const secret = encryptSecret(key, ownerId, "api_key", "s3cret");
  await q("insert into secrets (user_id, name, ciphertext, iv, auth_tag) values ($1, 'api_key', $2, $3, $4) returning id", [ownerId, secret.ciphertext, secret.iv, secret.authTag]);

  await migrate(pool);
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: key, secureCookies: false });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

describe("upgrade to workspace members (migration 0009)", () => {
  it("makes the existing account the owner of its workspace, with its data", async () => {
    const agent = request.agent(server);
    await agent.post("/auth/login").send({ email: "old.owner@test.local", password: PASSWORD }).expect(200);
    expect((await agent.get("/auth/me").expect(200)).body).toMatchObject({ id: ownerId, workspaceId: ownerId, role: "owner" });
    expect((await agent.get("/workflows").expect(200)).body.map((w: { id: string }) => w.id)).toEqual([workflowId]);
    expect((await agent.get("/secrets").expect(200)).body.map((s: { name: string }) => s.name)).toEqual(["api_key"]);
    expect(await readSecret(db, key, ownerId, "api_key")).toBe("s3cret");
  });

  it("keeps an approval link sent before the upgrade working for whoever holds it, once", async () => {
    await request(server).get(`/approvals/${token}`).expect(200);
    await request(server).post(`/approvals/${token}`).type("form").send({ decision: "approved" }).expect(200);
    await request(server).post(`/approvals/${token}`).type("form").send({ decision: "rejected" }).expect(404);
  });
});

// N3 upgrade: the newest migration (0019, bookings) applied to a database at 0018 that already holds a workspace, a
// published workflow, a resource and finished runs. The rows stay, the API still reads them, and the booking tables and
// their overlap rule (btree_gist, created by the migration itself) work on the upgraded database.
describe("upgrade from the previous migration (0018 to 0019)", () => {
  let p: Pool;
  let a: INestApplication;
  let b: PgBoss;
  let owner: string;
  let resource: string;
  let run: string;

  beforeAll(async () => {
    let url: string;
    let d: Db;
    ({ url, db: d, pool: p } = await freshDatabase({ migrated: false }));
    await migrateUpTo(p, 18);
    const q = async (sql: string, params: unknown[]) => (await p.query(sql, params)).rows[0] as { id: string };
    owner = (await q("insert into users (email, password_hash) values ($1, $2) returning id", ["n3.owner@test.local", await hash(PASSWORD)])).id;
    await q("insert into workspace_members (workspace_id, user_id, role) values ($1, $1, 'owner') returning user_id as id", [owner]);
    const wf = (await q("insert into workflows (user_id, name, slug) values ($1, 'Bookings', 'bookings') returning id", [owner])).id;
    const version = (await q("insert into workflow_versions (workflow_id, version, definition, published) values ($1, 1, '{}', true) returning id", [wf])).id;
    run = (await q("insert into runs (workflow_version_id, state) values ($1, 'succeeded') returning id", [version])).id;
    await q("insert into runs (workflow_version_id, state, error) values ($1, 'failed', 'smtp refused') returning id", [version]);
    resource = (await q("insert into resources (user_id, name) values ($1, 'Room A') returning id", [owner])).id;

    await migrate(p);
    b = new PgBoss(url);
    await b.start();
    a = await createApp({ db: d, boss: b, secretsKey: key, secureCookies: false });
    await a.init();
  }, 120_000);

  afterAll(async () => {
    await a?.close();
    await b?.stop({ graceful: false });
    await p?.end();
  });

  it("keeps the existing runs and resources, readable through the API", async () => {
    const agent = request.agent(a.getHttpServer());
    await agent.post("/auth/login").send({ email: "n3.owner@test.local", password: PASSWORD }).expect(200);
    const runs = (await agent.get("/runs").expect(200)).body as { state: string; error: string | null }[];
    expect(runs.map((r) => r.state).sort()).toEqual(["failed", "succeeded"]);
    expect(runs.find((r) => r.state === "failed")?.error).toBe("smtp refused");
    expect((await agent.get("/resources").expect(200)).body).toMatchObject([{ id: resource, name: "Room A" }]);
  });

  it("adds the booking tables with their overlap rule", async () => {
    const book = (ref: string, during: string) =>
      p.query("insert into bookings (user_id, test, reference, resource_id, during, timezone) values ($1, false, $2, $3, $4, 'UTC') returning id", [owner, ref, resource, during]);
    const { rows } = await book("B-1", "[2026-12-01 09:00Z,2026-12-01 10:00Z)");
    await p.query("update runs set booking_id = $1, booking_version = 1 where id = $2", [rows[0].id, run]);
    await expect(book("B-2", "[2026-12-01 09:30Z,2026-12-01 10:30Z)")).rejects.toThrow(/bookings_no_overlap/);
  });
});
