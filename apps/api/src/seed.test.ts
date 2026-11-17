import { randomBytes } from "node:crypto";
import { readProfile, requests, resolveSender, runs, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { TEMPLATES } from "@daloy/engine";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { DEMO_EMAIL, seed } from "./seed";

let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let baseUrl: string;
const key = randomBytes(32);

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: key, secureCookies: false });
  await app.listen(0);
  baseUrl = await app.getUrl();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

it("seeds the published examples and a disconnected email-in draft, and is safe to run twice", async () => {
  await seed(baseUrl);
  await seed(baseUrl);
  const [user] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL));
  const wfs = await db.select().from(workflows).where(eq(workflows.userId, user!.id));
  expect(wfs.map((w) => w.slug).sort()).toEqual([...TEMPLATES.slice(0, 3).map((t) => t.slug), "office-requests", "website-inquiries", "website-inbox"].sort());
  const versions = await db.select().from(workflowVersions);
  expect(versions.filter(v => v.published)).toHaveLength(5);
  const draft = versions.find(v => v.workflowId === wfs.find(w => w.slug === "website-inbox")!.id);
  expect(draft).toMatchObject({ published: false, definition: { trigger: { type: "email", config: {} } } });
  const seeded = await db.select().from(runs);
  // Only mocked test runs: the seed never sends live email.
  expect(seeded).toHaveLength(6);
  expect(seeded.find(r => r.workflowVersionId === draft!.id)?.triggerPayload).toMatchObject({ subject: "Question about Saturday delivery" });
  expect(seeded.every((r) => r.test && !r.live)).toBe(true);
  expect(await db.select().from(requests)).toEqual([]);
  expect(wfs.find((w) => w.slug === "office-requests")?.setup).toMatchObject({ template: "office-request" });
  // The demo owner connects no Gmail account, so its mail goes through the installation server (Mailpit locally).
  expect(await readProfile(db, user!.id)).toMatchObject({ businessName: "Daloy Demo Office", inquiryEmail: DEMO_EMAIL });
  expect(await resolveSender(db, key, user!.id)).toMatchObject({ kind: "installation", fromName: "Daloy Demo Office" });
}, 60_000);
