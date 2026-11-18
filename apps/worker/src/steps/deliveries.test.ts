import { generateKeyPairSync, randomBytes } from "node:crypto";
import { bookings, deliveries, encryptSecret, resources, retryDelivery, runs, saveConnection, secrets, smtpMailer, staffChange, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../../test/fake-providers";
import { startWorker, type Worker } from "../worker";
import { createExecutor } from "./index";

// The sheets, slack, outlook and teams steps queue deliveries, and the worker delivers each one apart from the run (decision 0021).
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

const microsoftDefinition = {
  trigger: definition.trigger,
  steps: [
    { id: "tell_purchasing", type: "outlook", config: { to: "{{trigger.email}}", subject: "Approved {{trigger.reference}}", text: "Buy {{trigger.summary}}. Door code {{secrets.door_code}}." } },
    { id: "post_to_teams", type: "teams", config: { text: "Purchase {{trigger.reference}} approved: {{trigger.summary}}" } },
  ],
  edges: [{ from: "tell_purchasing", to: "post_to_teams" }],
};

async function startRun(payload: object, extra: Partial<typeof runs.$inferInsert> = {}, def: object = definition) {
  const [wf] = await db.insert(workflows).values({ userId: owner, name: "Office requests", slug: `w${randomBytes(4).toString("hex")}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: def, published: true }).returning();
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
  fake.microsoft.refreshTokens.add("ms-refresh-worker");
  await saveConnection(db, key, owner, "outlook", { account: "office@contoso.example", credential: "ms-refresh-worker", destination: { mailbox: "office@contoso.example" } });
  await saveConnection(db, key, owner, "teams", { account: "Purchasing", credential: fake.teamsUrl("flow-purchasing"), destination: { channelName: "Purchasing" } });
  Object.assign(fake.airtable, { token: "patOFFICE.0123456789abcdef0123456789" });
  Object.assign(fake.notion, { token: "ntn_office0123456789abcdefghijkl" });
  Object.assign(fake.trello, { key: "office-key", token: "office-token" });
  await saveConnection(db, key, owner, "airtable", { account: fake.airtable.base, credential: fake.airtable.token, destination: { baseId: fake.airtable.base, tableId: fake.airtable.table } });
  await saveConnection(db, key, owner, "notion", { account: "Office requests", credential: fake.notion.token, destination: { databaseId: fake.notion.database, databaseTitle: "Office requests", titleProperty: "Name" } });
  await saveConnection(db, key, owner, "trello", { account: "@office", credential: JSON.stringify({ key: "office-key", token: "office-token" }), destination: { listId: fake.trello.list, listName: "To do" } });
  await db.insert(secrets).values({ userId: owner, name: "door_code", ...encryptSecret(key, owner, "door_code", "4417") });
  worker = await startWorker({
    connectionString: url,
    db,
    executor: createExecutor({ db, secretsKey: key, mail: { installation: smtpMailer({}), gmail: () => smtpMailer({}).transport, sharedMail: "open" } }),
    deliveries: { secretsKey: key, urls: { ...fake.urls, timeoutMs: 2000, microsoft: { clientId: fake.microsoft.clientId, clientSecret: fake.microsoft.clientSecret, tenant: "organizations" } } },
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
  // Secrets only reach HTTP steps (decision 0025), so a sheet column that names one stays empty.
  expect(rows[0]!.slice(2)).toEqual(["Printer jammed", ""]);

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

it("sends Outlook mail and a Teams note as deliveries, with secrets hidden", async () => {
  const runId = await startRun({ summary: "a desk lamp", email: "buy@contoso.example", reference: "PUR-2001" }, {}, microsoftDefinition);
  expect(await until(() => runState(runId), (s) => s === "succeeded" || s === "failed")).toBe("succeeded");
  const all = await until(() => deliveriesOf(runId), (d) => d.length === 2 && d.every((x) => x.state === "delivered"));
  expect(all.map((d) => d.provider).sort()).toEqual(["outlook", "teams"]);
  expect(fake.microsoft.sent).toEqual([{ to: "buy@contoso.example", subject: "Approved PUR-2001", text: "Buy a desk lamp. Door code ." }]);
  expect(fake.teams.posts.map((p) => p.text)).toEqual(["Purchase PUR-2001 approved: a desk lamp"]);
});

it("fails the step and queues nothing when the Outlook recipient is not an address", async () => {
  const runId = await startRun({ summary: "a desk lamp", email: "not-an-address", reference: "PUR-2002" }, {}, microsoftDefinition);
  expect(await until(() => runState(runId), (s) => s === "succeeded" || s === "failed")).toBe("failed");
  expect(await deliveriesOf(runId)).toEqual([]);
});

it("puts a booking on the calendar from a calendar step, and removes the event when staff cancel the booking (decision 0044)", async () => {
  const email = "calendar@office.iam.gserviceaccount.com";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fake.addServiceAccount(email, publicKey.export({ type: "spki", format: "pem" }).toString());
  const cal = fake.addCalendar("office@group.calendar.google.com", "Office", [email]);
  await saveConnection(db, key, owner, "google_calendar", {
    account: email,
    credential: JSON.stringify({ client_email: email, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }),
    destination: { calendarId: "office@group.calendar.google.com", title: "Office" },
  });
  const [ana] = await db.insert(resources).values({ userId: owner, name: "Ana" }).returning();
  const fields = [
    { name: "who", label: "Therapist", type: "resource", required: true },
    { name: "at", label: "Appointment", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
  ];
  const def = {
    trigger: { type: "webhook", config: { fields } },
    steps: [
      { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.who}}", start: "{{trigger.at}}", minutes: 60 } },
      { id: "calendar", type: "calendar", config: { title: "Massage with {{steps.book.output.resource.name}}", description: "Booking {{steps.book.output.reference}}" } },
    ],
    edges: [{ from: "book", to: "calendar", on: "done" }],
  };
  const runId = await startRun({ who: ana!.id, at: `${new Date().getUTCFullYear() + 1}-01-20T14:00` }, {}, def);
  expect(await until(() => runState(runId), (s) => s === "succeeded" || s === "failed")).toBe("succeeded");
  await until(() => deliveriesOf(runId), (d) => d.length === 1 && d[0]!.state === "delivered");
  const [event] = [...cal.events.values()];
  expect(event).toMatchObject({ status: "confirmed", summary: "Massage with Ana", start: { timeZone: "Asia/Manila" } });
  expect(event!.description).toMatch(/^Booking BK-/);

  const [booking] = await db.select().from(bookings).where(eq(bookings.userId, owner));
  expect((await staffChange(db, { workspaceId: owner, bookingId: booking!.id, version: 1, action: "cancel" }, "user:test")).result).toBe("done");
  await until(async () => [...cal.events.values()][0]!.status, (st) => st === "cancelled");
  expect(cal.events.size).toBe(1);
});

it("adds an Airtable record, a Notion page and a Trello card from run data, and queues nothing for a test run", async () => {
  const def = {
    trigger: definition.trigger,
    steps: [
      { id: "add_record", type: "airtable", config: { fields: { Summary: "{{trigger.summary}}", Ref: "{{trigger.reference}}" } } },
      { id: "add_page", type: "notion", config: { title: "{{trigger.summary}}", fields: { Notes: "{{trigger.reference}}" } } },
      { id: "add_card", type: "trello", config: { name: "{{trigger.summary}}", desc: "{{trigger.reference}}" } },
    ],
    edges: [{ from: "add_record", to: "add_page" }, { from: "add_page", to: "add_card" }],
  };
  const test = await startRun({ summary: "Fix door", reference: "REQ-4000" }, { test: true }, def);
  expect(await until(() => runState(test), (s) => s === "succeeded" || s === "failed")).toBe("succeeded");
  expect(await deliveriesOf(test)).toEqual([]);
  const runId = await startRun({ summary: "Fix door", reference: "REQ-4001" }, {}, def);
  expect(await until(() => runState(runId), (s) => s === "succeeded" || s === "failed")).toBe("succeeded");
  await until(() => deliveriesOf(runId), (d) => d.length === 3 && d.every((x) => x.state === "delivered"));
  expect(fake.airtable.records.map((r) => r.fields)).toEqual([{ Summary: "Fix door", Ref: "REQ-4001" }]);
  expect(fake.notion.pages).toHaveLength(1);
  expect(fake.trello.cards).toMatchObject([{ name: "Fix door", desc: "REQ-4001" }]);
});

it("counts Outlook recipients against the daily cap and sends the run to review instead of queueing the mail (N11b)", async () => {
  const [{ n }] = (await pool.query("select coalesce(sum(used), 0)::int as n from usage_counts where user_id = $1 and kind = 'mailbox'", [owner])).rows as [{ n: number }];
  const before = process.env.MAILBOX_DAILY_CAP;
  process.env.MAILBOX_DAILY_CAP = String(n + 1);
  try {
    const outlookOnly = { trigger: definition.trigger, steps: [microsoftDefinition.steps[0]!], edges: [] };
    const sentBefore = fake.microsoft.sent.length;
    const ok = await startRun({ summary: "a chair", email: "buy@contoso.example", reference: "PUR-3001" }, {}, outlookOnly);
    expect(await until(() => runState(ok), (s) => s === "succeeded" || s === "failed" || s === "needs_review")).toBe("succeeded");
    const capped = await startRun({ summary: "a desk", email: "buy@contoso.example", reference: "PUR-3002" }, {}, outlookOnly);
    expect(await until(() => runState(capped), (s) => s === "succeeded" || s === "failed" || s === "needs_review")).toBe("needs_review");
    const [run] = await db.select().from(runs).where(eq(runs.id, capped));
    expect(run!.error).toContain("limit of");
    expect(run!.error).toContain("Nothing was sent.");
    expect(await deliveriesOf(capped)).toEqual([]);
    await until(async () => fake.microsoft.sent.length, (c) => c === sentBefore + 1);
  } finally {
    if (before === undefined) delete process.env.MAILBOX_DAILY_CAP;
    else process.env.MAILBOX_DAILY_CAP = before;
  }
});
