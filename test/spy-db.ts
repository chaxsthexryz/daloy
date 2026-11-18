import type { Db } from "@daloy/db";

// A select builder, or what .from() returns (drizzle makes a new object at each step).
const isBuilder = (v: unknown): v is Builder => typeof v === "object" && v !== null && (typeof (v as Builder).then === "function" || "from" in v);

type Builder = { toSQL: () => { sql: string }; then?: (...a: unknown[]) => Promise<unknown> };

/**
 * Wraps a Db so a test can run code right after the first select that reads `table` resolves, once.
 * That is the moment between two reads of one request, where a republish from another request can land.
 */
export function spyDb(real: Db) {
  let armed: { table: string; run: () => Promise<void> } | undefined;
  const wrap = (b: Builder): Builder =>
    new Proxy(b, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== "function") return value;
        if (key === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            (value as (...a: unknown[]) => Promise<unknown>)
              .call(target, async (rows: unknown) => {
                const hook = armed && target.toSQL().sql.includes(`"${armed.table}"`) ? armed : undefined;
                if (hook) {
                  armed = undefined;
                  await hook.run();
                }
                return rows;
              })
              .then(resolve, reject);
        }
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return isBuilder(out) ? wrap(out) : out;
        };
      },
    });
  const db = new Proxy(real, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return key === "select" ? wrap(out as Builder) : out;
      };
    },
  }) as Db;
  return { db, afterFirstRead: (table: string, run: () => Promise<void>) => void (armed = { table, run }) };
}
