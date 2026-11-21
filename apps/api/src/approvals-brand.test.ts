import { randomBytes } from "node:crypto";
import { businessProfiles, createApproval, joinWorkspace, runs, sessions, stepRuns, users, workflows, workflowVersions, type Db, type Role } from "@daloy/db";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { createApp } from "./app";
import { sha256 } from "./http";

// E10 (decision 0079): the approval page carries its own workspace's brand and nobody else's. A file of its own because
// the approval POST is rate limited per IP.
let app: INestApplication;
let boss: PgBoss;
let db: Db;
let pool: Pool;
let server: Parameters<typeof request>[0];
let seq = 0;

async function account(role: Role, workspaceId?: string) {
  const [u] = await db.insert(users).values({ email: `brand${++seq}@test.local`, passwordHash: "x" }).returning();
  await joinWorkspace(db, u!.id, workspaceId ?? u!.id, workspaceId ? role : "owner");
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({ idHash: sha256(token), userId: u!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  return { id: u!.id, cookie: `daloy_session=${token}` };
}

/** A workspace with one workflow, optionally branded. */
async function workspace(brand?: { name: string; accent: string }) {
  const owner = await account("owner");
  if (brand) await db.insert(businessProfiles).values({ userId: owner.id, businessName: brand.name, accent: brand.accent });
  const [wf] = await db.insert(workflows).values({ userId: owner.id, name: "Purchases", slug: `p${seq}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  return { owner, versionId: v!.id };
}

async function approval(versionId: string, approverId?: string) {
  const [run] = await db.insert(runs).values({ workflowVersionId: versionId, state: "waiting", nextAttemptAt: new Date(Date.now() + 3_600_000) }).returning();
  const [step] = await db.insert(stepRuns).values({ runId: run!.id, stepId: "ask", attempt: 1, state: "waiting", input: { message: "Order 20 kg of flour?" } }).returning();
  return (await createApproval(db, step!.id, new Date(Date.now() + 3_600_000), approverId))!.token;
}

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

describe("approval page brand", () => {
  it("shows the workspace's business name and accent, and not the Daloy mark", async () => {
    const w = await workspace({ name: "Sampaguita <Bakery>", accent: "#1f6b45" });
    const page = await request(server).get(`/approvals/${await approval(w.versionId)}`).expect(200);
    expect(page.text).toContain("Sampaguita &lt;Bakery&gt;");
    expect(page.text).toContain("--accent:#1f6b45");
    expect(page.text).not.toContain(">Daloy<");
    expect(page.text).toContain("Order 20 kg of flour?");
    expect(page.text).toContain("Nothing is decided until you choose one of the two buttons.");
  });

  it("shows the Daloy mark when no brand is set, and never another workspace's brand", async () => {
    await workspace({ name: "Other Bakery", accent: "#aa0000" });
    const w = await workspace();
    const page = await request(server).get(`/approvals/${await approval(w.versionId)}`).expect(200);
    expect(page.text).toContain(">Daloy<");
    expect(page.text).toContain("--accent:#1b45c9");
    expect(page.text).not.toContain("Other Bakery");
    expect(page.text).not.toContain("#aa0000");
  });

  it("brands the sign-in and not-yours pages but keeps the request private", async () => {
    const w = await workspace({ name: "Sampaguita Bakery", accent: "#1f6b45" });
    const approver = await account("approver", w.owner.id);
    const stranger = await account("approver", w.owner.id);
    const token = await approval(w.versionId, approver.id);
    const signIn = await request(server).get(`/approvals/${token}`).expect(401);
    expect(signIn.text).toContain("Sampaguita Bakery");
    expect(signIn.text).not.toContain("Order 20 kg of flour?");
    const notYours = await request(server).get(`/approvals/${token}`).set("Cookie", stranger.cookie).expect(403);
    expect(notYours.text).toContain("Not your approval");
    expect(notYours.text).not.toContain("Order 20 kg of flour?");
  });

  it("gives an unknown link the plain not-valid page with no brand", async () => {
    await workspace({ name: "Sampaguita Bakery", accent: "#1f6b45" });
    const page = await request(server).get(`/approvals/${randomBytes(32).toString("base64url")}`).expect(404);
    expect(page.text).toContain("Link not valid");
    expect(page.text).toContain("Cannot be opened");
    expect(page.text).not.toContain("Sampaguita");
  });

  it("records the answer with an Approved label on the branded page", async () => {
    const w = await workspace({ name: "Sampaguita Bakery", accent: "#1f6b45" });
    const res = await request(server).post(`/approvals/${await approval(w.versionId)}`).type("form").send({ decision: "approved" }).expect(200);
    expect(res.text).toContain("Thanks. Your answer (approved) is recorded.");
    expect(res.text).toContain(">Approved<");
    expect(res.text).toContain("Sampaguita Bakery");
  });
});
