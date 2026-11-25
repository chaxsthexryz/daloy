import { randomBytes, randomUUID } from "node:crypto";
import { connections, runs, saveConnection, users, workflows, workflowVersions, workspaceMembers, type Db } from "@daloy/db";
import { READ_SPREADSHEET_MAX_BYTES, type Step } from "@daloy/engine";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../../test/db";
import { startFakeProviders, type FakeProviders } from "../../../../test/fake-providers";
import { createExecutor } from "./index";

// The read_spreadsheet step (M1, decision 0139) against the fake Drive. No real request leaves this file.
const key = randomBytes(32);
const NO_STEP_RUN = "00000000-0000-0000-0000-000000000000";
const GOOGLE_USER = { id: "google-user-m1", email: "seller@google.example" };
const ACCESS = "worker-test-access-token-m1"; // synthetic, no provider prefix so secret scanners stay quiet
const FOLDER = "1FolderForOrderExportsAbC";
const OTHER_FOLDER = "1FolderNobodyPickedXyZ";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SHEET = "application/vnd.google-apps.spreadsheet";
const EXPORT = '﻿Order ID,Order Status,Product Name,Quantity,Total Amount\r\n2411250001ABC,To ship,"Tote, canvas",2,450.00\r\n2411250002DEF,To ship,Mug,1,280.00\r\n\r\n';
let db: Db;
let pool: Pool;
let fake: FakeProviders;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  fake = await startFakeProviders();
  fake.addOAuthApp("google");
  fake.oauth.google!.accessTokens.set(ACCESS, GOOGLE_USER);
  fake.addDriveFolder(FOLDER, "Order exports", [GOOGLE_USER.email], null);
  fake.addDriveFolder(OTHER_FOLDER, "Someone else's", ["other@google.example"], null);
}, 120_000);
afterAll(async () => {
  await fake?.close();
  await pool?.end();
});

async function workspace(google: "oauth" | "service" | "none" = "oauth") {
  const [u] = await db.insert(users).values({ email: `seller-${randomUUID()}@test.local`, passwordHash: "x" }).returning();
  await db.insert(workspaceMembers).values({ userId: u!.id, workspaceId: u!.id, role: "owner" });
  if (google !== "none") {
    const blob = JSON.stringify({ v: 1, accessToken: ACCESS, accessExpiresAt: null, scope: "openid email https://www.googleapis.com/auth/drive.file" });
    await saveConnection(db, key, u!.id, "google_drive", { account: GOOGLE_USER.email, credential: google === "service" ? JSON.stringify({ client_email: "sa@x.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----" }) : blob, destination: { folderId: FOLDER, title: "Order exports" } });
    if (google === "oauth") await db.update(connections).set({ authMethod: "oauth", externalId: GOOGLE_USER.id }).where(and(eq(connections.userId, u!.id), eq(connections.provider, "google_drive")));
  }
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Orders", slug: `o-${randomUUID().slice(0, 8)}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: { trigger: { type: "manual", config: {} }, steps: [], edges: [] }, published: true }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id }).returning();
  return (step: Step, o: { mock?: boolean; trigger?: Record<string, unknown>; steps?: Record<string, { output: unknown }> } = {}) =>
    createExecutor({ db, secretsKey: key, mail: {} as never, urls: { ...fake.urls, timeoutMs: 2000 } }).execute({
      runId: r!.id,
      stepRunId: NO_STEP_RUN,
      userId: u!.id,
      workflowId: wf!.id,
      step,
      attempt: 1,
      idempotencyKey: `${r!.id}:${step.id}`,
      mock: o.mock,
      ctx: { trigger: o.trigger ?? {}, steps: o.steps ?? {} },
    });
}

const read = (fileId = "{{trigger.fileId}}"): Step => ({ id: "read", type: "read_spreadsheet", config: { fileId } });
const file = (name: string, mimeType: string, data: string | Buffer, folder = FOLDER) => ({ fileId: fake.addDriveFile(folder, { name, mimeType, data: Buffer.from(data) }) });
const failure = (p: Promise<unknown>) => p.then(() => "ok", (e: Error & { retryable: boolean }) => ({ retryable: e.retryable, message: e.message }));
const ORDERS = {
  columns: ["order_id", "order_status", "product_name", "quantity", "total_amount"],
  count: 2,
  rows: [
    { order_id: "2411250001ABC", order_status: "To ship", product_name: "Tote, canvas", quantity: "2", total_amount: "450.00" },
    { order_id: "2411250002DEF", order_status: "To ship", product_name: "Mug", quantity: "1", total_amount: "280.00" },
  ],
};

describe("read_spreadsheet step", () => {
  it("reads a CSV export from the trigger's file into rows keyed by header", async () => {
    const exec = await workspace();
    const out = await exec(read(), { trigger: file("shopee-orders.csv", "text/csv", EXPORT) });
    expect(out.output).toEqual({ name: "shopee-orders.csv", ...ORDERS });
  });

  it("converts an Excel export through a Google Sheets copy and deletes the copy", async () => {
    const exec = await workspace();
    const out = await exec(read(), { trigger: file("lazada-orders.xlsx", XLSX, EXPORT) });
    expect(out.output).toEqual({ name: "lazada-orders.xlsx", ...ORDERS });
    expect(fake.sheetCopies.size).toBe(0);
  });

  it("exports a Google Sheets file as CSV", async () => {
    const exec = await workspace();
    const out = await exec(read(), { trigger: file("Orders sheet", SHEET, EXPORT) });
    expect(out.output).toMatchObject({ count: 2, columns: ORDERS.columns });
  });

  it("takes the file id from a template other than the trigger", async () => {
    const exec = await workspace();
    const { fileId } = file("tiktok.csv", "text/csv", EXPORT);
    const out = await exec(read("{{steps.find.output.id}}"), { steps: { find: { output: { id: fileId } } } });
    expect(out.output).toMatchObject({ count: 2 });
  });

  it("feeds its rows into a batched Sheets append", async () => {
    const exec = await workspace();
    const { output } = await exec(read(), { trigger: file("feed.csv", "text/csv", EXPORT) });
    const sheets: Step = { id: "append", type: "sheets", config: { rows: "{{steps.read.output.rows}}", columns: ["{{item.order_id}}", "{{item.product_name}}", "{{item.total_amount}}"] } };
    const out = await exec(sheets, { mock: true, steps: { read: { output } } });
    expect(out.output).toMatchObject({ rows: [["2411250001ABC", "Tote, canvas", "450.00"], ["2411250002DEF", "Mug", "280.00"]] });
  });

  it("stops with a plain message over 2 MB or 2,000 rows, without retrying", async () => {
    const exec = await workspace();
    const big = await failure(exec(read(), { trigger: file("big.csv", "text/csv", Buffer.alloc(READ_SPREADSHEET_MAX_BYTES + 1, 97)) }));
    expect(big).toEqual({ retryable: false, message: expect.stringMatching(/larger than 2 MB/) });
    const many = "id\n" + Array.from({ length: 2001 }, (_, i) => String(i)).join("\n");
    expect(await failure(exec(read(), { trigger: file("many.csv", "text/csv", many) }))).toEqual({ retryable: false, message: expect.stringMatching(/2,001 rows.*at most 2,000/) });
  });

  it("refuses a file that is not a spreadsheet, and one this Google account cannot open", async () => {
    const exec = await workspace();
    expect(await failure(exec(read(), { trigger: file("receipt.pdf", "application/pdf", "%PDF-1.4") }))).toEqual({ retryable: false, message: expect.stringMatching(/not a CSV, Excel or Google Sheets file/) });
    expect(await failure(exec(read(), { trigger: file("x.csv", "text/csv", EXPORT, OTHER_FOLDER) }))).toEqual({ retryable: false, message: expect.stringMatching(/cannot open this file/) });
    expect(await failure(exec(read(), { trigger: {} }))).toEqual({ retryable: false, message: expect.stringMatching(/no file to read/) });
  });

  it("explains what to fix when Drive is not connected with a Google sign-in", async () => {
    expect(await failure((await workspace("none"))(read(), { trigger: { fileId: "1AnyFileIdAbCdEf" } }))).toMatchObject({ retryable: false, message: expect.stringMatching(/Connect Google Drive/) });
    expect(await failure((await workspace("service"))(read(), { trigger: { fileId: "1AnyFileIdAbCdEf" } }))).toMatchObject({ retryable: false, message: expect.stringMatching(/Google sign-in/) });
  });

  it("retries a rate limit and deletes the Excel copy even when the export fails", async () => {
    const exec = await workspace();
    fake.once("/export", { status: 429, headers: { "retry-after": "2" }, body: {} });
    const err = await exec(read(), { trigger: file("throttled.xlsx", XLSX, EXPORT) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: true, outcome: "throttled", retryAfterMs: 2000 });
    expect(fake.sheetCopies.size).toBe(0);
  });

  it("a test run returns sample orders and reads nothing", async () => {
    const exec = await workspace("none");
    const out = await exec(read(), { mock: true, trigger: { fileId: "1AnyFileIdAbCdEf" } });
    expect(out.output).toMatchObject({ mocked: true, count: 2, columns: expect.arrayContaining(["order_id"]) });
  });
});
