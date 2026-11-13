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

/** Applies migrations 0000 to 0008 only, from a copy of the folder with a trimmed journal. */
async function migrateTo0008(p: Pool) {
  const source = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "daloy-migrations-"));
  cpSync(source, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 8);
  writeFileSync(journalPath, JSON.stringify(journal));
  await runMigrations(drizzle(p), { migrationsFolder: dir });
  rmSync(dir, { recursive: true, force: true });
}

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase({ migrated: false }));
  await migrateTo0008(pool);
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
