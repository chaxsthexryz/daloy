import { randomBytes } from "node:crypto";
import { createDue, decideClaim, joinWorkspace, paymentDues, runs, sessions, submitTransferClaim, users, workflows, workflowVersions, type Db } from "@daloy/db";
import { eq } from "drizzle-orm";
import { hash } from "@node-rs/argon2";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { sha256 } from "./http";

// N19: CSV downloads for an automation's Activity and for Bookings. R5: the payments export reuses the same cell escaping.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];

beforeAll(async () => {
  let url: string;
  ({ url, db, pool } = await freshDatabase());
  boss = new PgBoss(url);
  await boss.start();
  app = await createApp({ db, boss, secretsKey: randomBytes(32), secureCookies: false });
  await app.init();
  server = app.getHttpServer();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await pool?.end();
});

type Agent = ReturnType<typeof request.agent>;
let seq = 0;
async function owner() {
  const agent = request.agent(server);
  await agent.post("/auth/register").send({ email: `csv${++seq}@test.local`, password: "correct horse battery" }).expect(201);
  return agent;
}
async function member(boss: Agent, role: "operator" | "approver" | "requester") {
  const workspaceId = (await boss.get("/auth/me").expect(200)).body.workspaceId as string;
  const [u] = await db.insert(users).values({ email: `csvm${++seq}@test.local`, passwordHash: await hash("correct horse battery") }).returning();
  await joinWorkspace(db, u!.id, workspaceId, role);
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return request.agent(server).set("Cookie", `daloy_session=${token}`);
}
async function workflow(agent: Agent) {
  const wf = await agent.post("/workflows").send({ name: "Orders", slug: `csv-${++seq}` }).expect(201);
  const definition = { trigger: { type: "manual" }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }], edges: [] };
  await agent.post(`/workflows/${wf.body.id}/versions`).send({ definition, publish: true }).expect(201);
  return wf.body.id as string;
}
const text = async (agent: Agent, path: string) => {
  const res = await agent.get(path).expect(200);
  return { res, lines: (res.text as string).split("\r\n").filter(Boolean) };
};

describe("activity CSV", () => {
  it("lists the standard columns, then the form fields, and escapes formulas and hides secrets", async () => {
    const o = await owner();
    const id = await workflow(o);
    await o.post(`/workflows/${id}/runs`).send({ payload: { name: "=HYPERLINK(\"x\")", note: "a,b", phone: "+639171234567", password: "hunter2", plain: "Ana" } }).expect(202);
    const { res, lines } = await text(o, `/runs/export.csv?workflowId=${id}`);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    // The database stores the payload as jsonb, which orders keys by length, so only the set of field columns is fixed.
    const head = lines[0]!.split(",");
    expect(head.slice(0, 5)).toEqual(["reference", "state", "test", "created", "finished"]);
    expect(head.slice(5).sort()).toEqual(["name", "note", "password", "phone", "plain"]);
    const row = lines[1]!;
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
    expect(row).toContain('"a,b"');
    expect(row).toContain("'+639171234567");
    expect(row).toContain("[secret]");
    expect(row).not.toContain("hunter2");
    expect(row).toMatch(/(^|,)Ana(,|$)/);
  });

  it("allows owners and operators only, and only the caller's workspace", async () => {
    const o = await owner();
    const id = await workflow(o);
    const path = `/runs/export.csv?workflowId=${id}`;
    await text(await member(o, "operator"), path);
    await (await member(o, "approver")).get(path).expect(403);
    await (await member(o, "requester")).get(path).expect(403);
    await request(server).get(path).expect(401);
    await (await owner()).get(path).expect(200).then((r) => expect((r.text as string).split("\r\n").filter(Boolean)).toHaveLength(1));
    await o.get("/runs/export.csv").expect(400);
  });
});

describe("bookings CSV", () => {
  it("has the booking columns and the same role rules", async () => {
    const o = await owner();
    const { lines } = await text(o, "/bookings/export.csv");
    expect(lines).toEqual(["reference,resource,start,end,minutes,timezone,status"]);
    await text(await member(o, "operator"), "/bookings/export.csv");
    await (await member(o, "approver")).get("/bookings/export.csv").expect(403);
    await request(server).get("/bookings/export.csv").expect(401);
  });
});

describe("payments CSV (R5)", () => {
  /** A confirmed payment: a transfer claim the owner confirmed, then its confirmation moved to the given Manila time. */
  async function confirmed(agent: Agent, o: { reference: string; transferRef?: string; amount?: number; at: string; test?: boolean; kind?: "deposit" | "full" }) {
    const workspaceId = (await agent.get("/auth/me").expect(200)).body.workspaceId as string;
    const [wf] = await db.insert(workflows).values({ userId: workspaceId, name: "Pay", slug: `pay-${++seq}` }).returning();
    const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
    const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
    const due = await createDue(db, { userId: workspaceId, test: o.test ?? false, workflowId: wf!.id, runId: r!.id, stepId: "ask", reference: o.reference, kind: o.kind ?? "full", amountCentavos: o.amount ?? 123456 });
    const claim = (await submitTransferClaim(db, due.token, { transferRef: o.transferRef ?? `T${seq}${seq}${seq}` }))!;
    await decideClaim(db, { workspaceId, actor: { id: workspaceId, role: "owner" }, claimId: claim.id, version: claim.version, decision: "confirm" });
    await db.update(paymentDues).set({ confirmedAt: new Date(Date.parse(`${o.at}Z`) - 8 * 3600_000) }).where(eq(paymentDues.id, due.id));
    return due;
  }
  const url = (from = "2026-11-01", to = "2026-11-30") => `/payments/export.csv?from=${from}&to=${to}`;

  it("has the bookkeeping columns, whole pesos with centavos, and the confirmation source", async () => {
    const o = await owner();
    await confirmed(o, { reference: "D-1042", transferRef: "GC 7788", amount: 123456, at: "2026-11-05T09:30:00", kind: "deposit" });
    const { res, lines } = await text(o, url());
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("payments-2026-11-01-to-2026-11-30.csv");
    expect(lines[0]).toBe("confirmed_on,confirmed_at,reference,booking,kind,amount_php,total_php,status,source,transfer_reference,confirmed_by");
    const cells = lines[1]!.split(",");
    expect(cells.slice(0, 3)).toEqual(["2026-11-05", "2026-11-05T01:30:00.000Z", "D-1042"]);
    expect(cells.slice(4, 10)).toEqual(["deposit", "1234.56", "", "confirmed", "transfer", "GC 7788"]);
    expect(cells[10]).toMatch(/@test\.local$/);
  });

  it("filters by Manila day, inclusive at both ends, and leaves out test payments and other workspaces", async () => {
    const o = await owner();
    await confirmed(o, { reference: "IN-FIRST", at: "2026-11-01T00:00:00" });
    await confirmed(o, { reference: "IN-LAST", at: "2026-11-30T23:59:00" });
    await confirmed(o, { reference: "OUT-BEFORE", at: "2026-10-31T23:59:00" });
    await confirmed(o, { reference: "OUT-AFTER", at: "2026-12-01T00:00:00" });
    await confirmed(o, { reference: "OUT-TEST", at: "2026-11-10T10:00:00", test: true });
    const other = await owner();
    await confirmed(other, { reference: "OUT-OTHER", at: "2026-11-10T10:00:00" });
    const { lines } = await text(o, url());
    expect(lines.slice(1).map((l) => l.split(",")[2]).sort()).toEqual(["IN-FIRST", "IN-LAST"]);
  });

  it("neutralizes spreadsheet formulas in the reference and the transfer reference", async () => {
    const o = await owner();
    await confirmed(o, { reference: "=HYPERLINK(\"x\")", transferRef: "-1+1", at: "2026-11-05T09:30:00" });
    const { lines } = await text(o, url());
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[1]).toContain(",'-1+1,");
    expect(lines[1]).not.toMatch(/(^|,)=HYPERLINK/);
  });

  it("allows owners and operators only", async () => {
    const o = await owner();
    await text(await member(o, "operator"), url());
    await (await member(o, "approver")).get(url()).expect(403);
    await (await member(o, "requester")).get(url()).expect(403);
    await request(server).get(url()).expect(401);
  });

  it("needs a valid range of at most a year", async () => {
    const o = await owner();
    await o.get("/payments/export.csv").expect(400);
    await o.get(url("2026-11-30", "2026-11-01")).expect(400);
    await o.get(url("2026-02-30", "2026-03-01")).expect(400);
    await o.get(url("2025-01-01", "2026-11-30")).expect(400);
    await o.get(url("2025-12-01", "2026-11-30")).expect(200);
  });
});
