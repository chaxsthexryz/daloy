import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}

/** One Postgres for the whole test run: DATABASE_URL in CI, an embedded server locally (decision 0003). */
export default async function setup(project: TestProject) {
  let url = process.env.DATABASE_URL;
  let pg: EmbeddedPostgres | undefined;
  if (!url) {
    pg = new EmbeddedPostgres({
      databaseDir: mkdtempSync(join(tmpdir(), "daloy-pg-")),
      port: 54329,
      user: "daloy",
      password: "daloy",
      persistent: false,
      onLog: () => {},
    });
    await pg.initialise();
    await pg.start();
    url = "postgres://daloy:daloy@localhost:54329/postgres";
  }
  project.provide("adminDatabaseUrl", url);
  return async () => {
    await pg?.stop();
  };
}
