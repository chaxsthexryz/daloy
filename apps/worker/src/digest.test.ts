import { randomBytes } from "node:crypto";
import { createDue, deliveries, runs, submitTransferClaim, users, workflows, workflowVersions, type Db, type MailDeps } from "@daloy/db";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeSmtp } from "../../../test/fake-smtp";
import { sendDigests } from "./digest";

// R5, decision 0092: the owner's morning digest. Times are written in Manila (UTC+8) and shifted to UTC.
const key = randomBytes(32);
const manila = (s: string) => new Date(Date.parse(`${s}Z`) - 8 * 3600_000);
let db: Db;
let pool: Pool;
let smtp: Awaited<ReturnType<typeof startFakeSmtp>>;
let seq = 0;

const mail = (port = smtp.port): MailDeps => ({
  installation: { transport: nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true }), from: "kymavo <daloy@localhost>" },
  gmail: () => {
    throw new Error("not used");
  },
  sharedMail: "approved",
});
const tick = (at: string, deps = mail()) => sendDigests({ db, mail: deps, secretsKey: key, publicUrl: "https://daloy.example.com", now: manila(at) });
const sent = (to: string) => smtp.messages.filter((m) => m.to.includes(to)).map((m) => ({ ...m, raw: m.raw.replace(/=\r?\n/g, "") }));

async function owner(o: { digest?: boolean; language?: "en" | "tl" } = {}) {
  const email = `dg${++seq}@test.local`;
  const [u] = await db.insert(users).values({ email, passwordHash: "x", digestEnabled: o.digest ?? true, language: o.language ?? "en" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "Orders", slug: `o-${seq}` }).returning();
  return { id: u!.id, email, wf: wf!.id };
}
async function newRun(wf: string, test = false) {
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf, version: ++seq, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {}, test }).returning();
  return r!.id;
}
const dueFor = async (o: { id: string; wf: string }, over: { test?: boolean } = {}) =>
  createDue(db, { userId: o.id, test: over.test ?? false, workflowId: o.wf, runId: await newRun(o.wf, over.test), stepId: "ask", reference: `D-${++seq}`, kind: "full", amountCentavos: 50000 });
async function receipt(o: { id: string; wf: string }) {
  const d = await dueFor(o);
  await submitTransferClaim(db, d.token, { transferRef: `REF${seq}${seq}` });
  return d;
}
async function failedReply(o: { id: string; wf: string }, state: "failed" | "needs_review" | "delivered" = "failed", test = false) {
  await db.insert(deliveries).values({ userId: o.id, runId: await newRun(o.wf, test), stepId: "s", provider: "unisms", reference: `R${++seq}`, payload: { to: "+639171234567", message: "hi" }, state });
}

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  smtp = await startFakeSmtp();
}, 120_000);
afterAll(async () => {
  await pool?.end();
  smtp?.close();
});

describe("morning digest", () => {
  it("sends one email from 8 am Manila, with counts and links, and not again that day", async () => {
    const o = await owner();
    await receipt(o);
    await receipt(o);
    await dueFor(o);
    await failedReply(o);
    await tick("2026-11-20T07:59:00");
    expect(sent(o.email)).toHaveLength(0);
    await tick("2026-11-20T08:00:00");
    await tick("2026-11-20T09:30:00");
    const [m] = sent(o.email);
    expect(sent(o.email)).toHaveLength(1);
    expect(m!.raw).toContain("2 receipts to review");
    // Two of the three dues have a receipt claim, and every due without a confirmation is unpaid.
    expect(m!.raw).toContain("3 unpaid orders");
    expect(m!.raw).toContain("1 failed reply");
    expect(m!.raw).toContain("https://daloy.example.com/#/receipts");
    expect(m!.raw).toContain("https://daloy.example.com/#/activity");
    await tick("2026-11-21T08:05:00");
    expect(sent(o.email)).toHaveLength(2);
  });

  it("stays quiet in the afternoon, so a down worker does not send a stale morning email", async () => {
    const o = await owner();
    await receipt(o);
    await tick("2026-11-20T12:00:00");
    await tick("2026-11-20T15:00:00");
    await tick("2026-11-20T03:00:00");
    expect(sent(o.email)).toHaveLength(0);
    await tick("2026-11-20T11:59:00");
    expect(sent(o.email)).toHaveLength(1);
  });

  it("sends nothing when there is nothing to do, and that uses up the day", async () => {
    const o = await owner();
    await tick("2026-11-20T08:00:00");
    await receipt(o);
    await tick("2026-11-20T10:00:00");
    expect(sent(o.email)).toHaveLength(0);
    await tick("2026-11-21T08:00:00");
    expect(sent(o.email)).toHaveLength(1);
  });

  it("is off until the owner turns it on", async () => {
    const o = await owner({ digest: false });
    await receipt(o);
    await tick("2026-11-20T08:00:00");
    expect(sent(o.email)).toHaveLength(0);
    await db.update(users).set({ digestEnabled: true }).where(eq(users.id, o.id));
    await tick("2026-11-20T08:01:00");
    expect(sent(o.email)).toHaveLength(1);
  });

  it("counts only this workspace's real work: no test runs, no delivered replies, no other workspace", async () => {
    const o = await owner();
    const x = await owner();
    await dueFor(o, { test: true });
    await failedReply(o, "delivered");
    await failedReply(o, "failed", true);
    await failedReply(x);
    await receipt(x);
    await failedReply(o, "needs_review");
    await tick("2026-11-20T08:00:00");
    const [m] = sent(o.email);
    expect(m!.raw).toContain("1 failed reply");
    expect(m!.raw).not.toContain("receipt");
    expect(m!.raw).not.toContain("unpaid");
  });

  it("gives the day back when the email fails, and the next tick sends it", async () => {
    const o = await owner();
    await receipt(o);
    await tick("2026-11-20T08:00:00", mail(1));
    expect(sent(o.email)).toHaveLength(0);
    await tick("2026-11-20T08:01:00");
    expect(sent(o.email)).toHaveLength(1);
  });

  it("writes Tagalog for a Tagalog workspace and puts no customer detail in the email", async () => {
    const o = await owner({ language: "tl" });
    await receipt(o);
    await tick("2026-11-20T08:00:00");
    const [m] = sent(o.email);
    expect(m!.raw).toContain("resibong susuriin");
    expect(m!.raw).not.toContain("639171234567");
    expect(m!.raw).not.toMatch(/REF\d/);
  });
});
