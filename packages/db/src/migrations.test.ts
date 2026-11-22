import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const folder = fileURLToPath(new URL("../migrations", import.meta.url));
const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as { entries: { idx: number; when: number; tag: string }[] };

describe("migration journal", () => {
  // Drizzle applies a migration only when its `when` is later than the newest one the database has. An entry that is
  // older than the one before it is skipped for good on any database that was migrated step by step (decision 0101).
  it("has strictly increasing timestamps", () => {
    const late = journal.entries.filter((entry, i) => i > 0 && entry.when <= journal.entries[i - 1]!.when).map((entry) => entry.tag);
    expect(late).toEqual([]);
  });

  it("numbers entries in order and has a file for each", () => {
    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      expect(entry.tag.startsWith(String(i).padStart(4, "0"))).toBe(true);
      expect(existsSync(`${folder}/${entry.tag}.sql`)).toBe(true);
    });
  });
});
