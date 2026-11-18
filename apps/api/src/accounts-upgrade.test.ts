import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { migrate, runs, type Db } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";

// N11a upgrade: a database at 0030 with an account, a signed-in session and an API token made the old way. After 0031
// the cookie still signs in and the token still has every tool, since old tokens get all three scopes and no expiry.

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let base: string;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const cookie = randomBytes(32).toString("base64url");
const token = `dly_${randomBytes(32).toString("base64url")}`;
const PASSWORD = "correct horse battery";

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
  await migrateUpTo(pool, 30);
  // Raw SQL: the current Drizzle schema has columns that 0030 doesn't.
  const q = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0] as { id: string };
  const owner = (await q("insert into users (email, password_hash) values ($1, $2) returning id", ["n11a.owner@test.local", await hash(PASSWORD)])).id;
  await q("insert into workspace_members (workspace_id, user_id, role) values ($1, $1, 'owner') returning user_id as id", [owner]);
  await q("insert into sessions (id_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day') returning user_id as id", [sha(cookie), owner]);
  await q("insert into api_tokens (user_id, name, token_hash) values ($1, 'old claude', $2) returning id", [owner, sha(token)]);

  await migrate(pool);
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

const signedIn = () => request.agent(app.getHttpServer()).set("Cookie", `daloy_session=${cookie}`);

describe("upgrade to accounts and token scopes (migration 0031)", () => {
  it("keeps the session cookie working", async () => {
    expect((await signedIn().get("/auth/me").expect(200)).body).toMatchObject({ email: "n11a.owner@test.local", role: "owner" });
  });

  it("gives the old token every scope and no expiry", async () => {
    const [row] = (await signedIn().get("/tokens").expect(200)).body as { name: string; scopes: string[]; expiresAt: string | null; revokedAt: string | null }[];
    expect(row).toMatchObject({ name: "old claude", scopes: ["read", "run", "manage"], expiresAt: null, revokedAt: null });
  });

  it("keeps the old token listing every tool and starting runs", async () => {
    const agent = signedIn();
    const wf = await agent.post("/workflows").send({ name: "Inquiry", slug: "inquiry" }).expect(201);
    const definition = { trigger: { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }] } }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
    await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);

    const client = new Client({ name: "upgrade-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["cancel_booking", "get_run_status", "inquiry", "list_bookings", "reschedule_booking", "resolve_run"]);
    const res = await client.callTool({ name: "inquiry", arguments: { email: "ana@example.com" } });
    const { runId } = res.structuredContent as { runId: string };
    expect(await db.select().from(runs).where(eq(runs.id, runId))).toHaveLength(1);
    await client.close();
  });
});
