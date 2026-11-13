import { generateKeyPairSync, randomBytes } from "node:crypto";
import { deliveries, encryptSecret, retryDelivery, runs, saveConnection, secrets, smtpMailer, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../../test/fake-providers";
import { startWorker, type Worker } from "../worker";
import { createExecutor } from "./index";

// The sheets and slack steps queue deliveries, and the worker delivers each one apart from the run (decision 0021).
const key = randomBytes(32);
let db: Db;
let pool: Pool;
let fake: FakeProviders;
let worker: Worker;
let owner: string;
let rows: string[][];

const definition = {
  trigger: { type: "form", config: { fields: [{ name: "summary", label: "What needs attention?", type: "text", required: true }] } },
  steps: [
    { id: "add_to_sheet", type: "sheets", config: { columns: ["{{trigger.summary}}", "{{secrets.door_code}}"] } },
    { id: "post_to_slack", type: "slack", config: { text: "New request {{trigger.reference}}: {{trigger.summary}}" } },
  ],
  edges: [{ from: "add_to_sheet", to: "post_to_slack" }],
};

async function startRun(payload: object, extra: Partial<typeof runs.$inferInsert> = {}) {
  const [wf] = await db.insert(workflows).values({ userId: owner, name: "Office requests", slug: `w${randomBytes(4).toString("hex")}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: true }).returning();
  const [run] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: payload, ...extra }).returning();
  await worker.enqueue(run!.id);
  return run!.id;
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting");
}
const runState = async (id: string) => (await db.select().from(runs).where(eq(runs.id, id)))[0]!.state;
const deliveriesOf = (runId: string) => db.select().from(deliveries).where(eq(deliveries.runId, runId)).orderBy(deliveries.stepId);

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  const [u] = await db.insert(users).values({ email: "office@test.local", passwordHash: "x" }).returning();
  owner = u!.id;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fake.addServiceAccount("sheets@office.iam.gserviceaccount.com", publicKey.export({ type: "spki", format: "pem" }).toString());
  rows = fake.addSheet("sheet-office", "Office requests", "Requests", ["sheets@office.iam.gserviceaccount.com"]).tabs.get("Requests")!;
  fake.slack.token = "xoxb-office";
  await saveConnection(db, key, owner, "google_sheets", {
    account: "sheets@office.iam.gserviceaccount.com",
    credential: JSON.stringify({ client_email: "sheets@office.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }),
    destination: { spreadsheetId: "sheet-office", tab: "Requests", title: "Office requests" },
  });
  await saveConnection(db, key, owner, "slack", { account: "Office", credential: "xoxb-office", destination: { channelId: "C0REQ", channelName: "office-requests" } });
  await db.insert(secrets).values({ userId: owner, name: "door_code", ...encryptSecret(key, owner, "door_code", "4417") });
  worker = await startWorker({
    connectionString: url,
    db,
    executor: createExecutor({ db, secretsKey: key, mail: { installation: smtpMailer({}), gmail: () => smtpMailer({}).transport } }),
    deliveries: { secretsKey: key, urls: { ...fake.urls, timeoutMs: 2000 } },
    pollingIntervalSeconds: 0.5,
    sweepMs: 500,
  });
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  await fake?.close();
  await pool?.end();
});

it("finishes the run, writes the sheet row, and retries only the Slack post that failed", async () => {
  fake.slack.channels[0]!.is_member = false;
  const runId = await startRun({ summary: "Printer jammed", reference: "REQ-2001" });
  expect(await until(() => runState(runId), (s) => s === "succeeded" || s === "failed")).toBe("succeeded");
  const [sheet, slack] = await until(() => deliveriesOf(runId), (d) => d.length === 2 && d.every((x) => x.state === "delivered" || x.state === "failed"));
  expect(sheet).toMatchObject({ provider: "google_sheets", reference: "REQ-2001", state: "delivered" });
  expect(slack).toMatchObject({ provider: "slack", state: "failed" });
  // The row starts with the reference and the time, and a secret is never sent to a provider.
  expect(rows).toHaveLength(1);
  expect(rows[0]![0]).toBe("REQ-2001");
  expect(rows[0]!.slice(2)).toEqual(["Printer jammed", "[secret]"]);

  fake.slack.channels[0]!.is_member = true;
  expect(await retryDelivery(db, owner, slack!.id)).toBe(true);
  await until(() => deliveriesOf(runId), (d) => d[1]!.state === "delivered");
  expect(fake.slack.messages.map((m) => m.text)).toEqual(["New request REQ-2001: Printer jammed"]);
  expect(rows).toHaveLength(1);
});

it("queues nothing for a builder test run, and shows the row and message instead", async () => {
  const runId = await startRun({ summary: "Light flickers", reference: "REQ-SAMPLE" }, { test: true });
  expect(await until(() => runState(runId), (s) => s === "succeeded" || s === "failed")).toBe("succeeded");
  expect(await deliveriesOf(runId)).toEqual([]);
});
