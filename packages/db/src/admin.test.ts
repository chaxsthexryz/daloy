import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { adminRead } from "./admin";
import { users } from "./schema";
import type { Db } from "./index";

let db: Db;
let pool: Pool;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
}, 120_000);

afterAll(async () => {
  await pool?.end();
});

describe("adminRead", () => {
  // 25006 is read_only_sql_transaction.
  it("runs in a read-only transaction, so Postgres refuses any write on the admin read path", async () => {
    await expect(adminRead(db, (tx) => tx.insert(users).values({ email: "x@test.local", passwordHash: "x" }))).rejects.toMatchObject({ cause: { code: "25006" } });
    expect(await adminRead(db, (tx) => tx.select({ id: users.id }).from(users))).toEqual([]);
  });

  it("never reaches the secrets code: the module imports no decrypt or crypto helper", () => {
    const source = readFileSync(new URL("./admin.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
    expect(imports.every((i) => ["drizzle-orm", "./schema", "./usage", "./index"].includes(i!))).toBe(true);
    expect(source).not.toMatch(/decrypt|secretsKey|triggerPayload|testChoices|\.input\b|\.output\b|lastError/);
  });
});
