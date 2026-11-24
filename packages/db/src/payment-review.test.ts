import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import type { Db } from "./index";
import { createDue, decideClaim, DueTakenError, duesForBooking, expireDue, extractDmReceiptAmount, extractDmReceiptRef, retryReply, reviewList, settleCheckout, submitDmReceiptClaim, submitTransferClaim, type Due } from "./payment-review";
import { insertPayment, markPaymentPaid, markPaymentRefunded } from "./paymongo";
import { conversations, deliveries, paymentClaims, paymentDues, paymentHistory, payments, receiptReferences, runs, users, workflows, workflowVersions, workspaceMembers } from "./schema";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let db: Db;
let pool: Pool;
let owner: string;
let operator: string;
let other: string;
let workflowId: string;
let n = 0;

async function newRun(userId = owner) {
  const [wf] = userId === owner ? [{ id: workflowId }] : await db.insert(workflows).values({ userId, name: "X", slug: `x-${++n}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: ++n, definition: {} }).returning();
  const [r] = await db.insert(runs).values({ workflowVersionId: v!.id, triggerPayload: {} }).returning();
  return { runId: r!.id, workflowId: wf!.id };
}

async function due(over: Partial<Parameters<typeof createDue>[1]> = {}): Promise<Due> {
  const { runId, workflowId: wf } = await newRun(over.userId);
  return createDue(db, { userId: owner, test: false, workflowId: wf, runId, stepId: "ask", reference: `D-${++n}`, kind: "deposit", amountCentavos: 35000, replyChannel: "sms", replyTo: "+639171234567", replyText: "Deposit received, see you!", ...over });
}

/** A checkout session made for a due, as the payment_due step stores it. */
async function checkout(d: Due, amountCentavos = d.amountCentavos) {
  return insertPayment(db, { userId: d.userId, workflowId: d.workflowId!, runId: d.runId, stepId: d.stepId, reference: d.reference, amountCentavos, livemode: false, providerSessionId: `cs_${randomUUID()}`, url: "https://pm.test/x", dueId: d.id });
}

async function paid(p: { providerSessionId: string; userId: string }, amount: number, paymentId = `pay_${randomUUID()}`) {
  const r = await markPaymentPaid(db, { userId: p.userId, sessionId: p.providerSessionId, paymentId, amount, currency: "PHP", livemode: false });
  await settleCheckout(db, p.userId, r.payment!.id);
  return r.payment!;
}

const fresh = async (id: string) => (await db.select().from(paymentDues).where(eq(paymentDues.id, id)))[0]!;
const claimRow = async (id: string) => (await db.select().from(paymentClaims).where(eq(paymentClaims.id, id)))[0]!;
const replies = async (d: Due) => db.select().from(deliveries).where(eq(deliveries.runId, d.runId));
const history = async (d: Due) => (await db.select().from(paymentHistory).where(eq(paymentHistory.dueId, d.id)).orderBy(asc(paymentHistory.at))).map((h) => h.event);
const asOwner = { id: "", role: "owner" as const };

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  const [o] = await db.insert(users).values({ email: "seller@test.local", passwordHash: "x" }).returning();
  const [op] = await db.insert(users).values({ email: "staff@test.local", passwordHash: "x" }).returning();
  const [x] = await db.insert(users).values({ email: "else@test.local", passwordHash: "x" }).returning();
  owner = o!.id;
  operator = op!.id;
  other = x!.id;
  asOwner.id = owner;
  await db.insert(workspaceMembers).values([
    { userId: owner, workspaceId: owner, role: "owner" },
    { userId: operator, workspaceId: owner, role: "operator" },
    { userId: other, workspaceId: other, role: "owner" },
  ]);
  const [wf] = await db.insert(workflows).values({ userId: owner, name: "Deposits", slug: "deposits" }).returning();
  workflowId = wf!.id;
}, 120_000);
afterAll(() => pool?.end());

describe("createDue", () => {
  it("returns the same due when the step runs again, and refuses a second open deposit for the same order", async () => {
    const { runId } = await newRun();
    const v = { userId: owner, test: false, workflowId, runId, stepId: "ask", reference: "D-7001", kind: "deposit" as const, amountCentavos: 35000 };
    const a = await createDue(db, v);
    const b = await createDue(db, v);
    expect(b.id).toBe(a.id);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const again = await newRun();
    await expect(createDue(db, { ...v, runId: again.runId })).rejects.toBeInstanceOf(DueTakenError);
    // A balance for the same order is a different amount owed.
    expect((await createDue(db, { ...v, runId: again.runId, kind: "balance" })).kind).toBe("balance");
    expect(await history(a)).toEqual(["requested"]);
  });
});

describe("manual transfer claims", () => {
  it("flags a reused reference, a wrong amount and an unreadable upload, and keeps the due pending", async () => {
    const first = await due();
    const a = await submitTransferClaim(db, first.token, { transferRef: "5012 345 678 901", submittedCentavos: 35000, image: { bytes: PNG } });
    expect(a!.flags).toEqual([]);
    expect(a!.imageType).toBe("png");
    const second = await due();
    const b = await submitTransferClaim(db, second.token, { transferRef: "5012-3456-78901", submittedCentavos: 30000, image: { bytes: Buffer.from("not an image") } });
    expect(b!.flags.sort()).toEqual(["amount_mismatch", "duplicate_reference", "unreadable_upload"]);
    expect(b!.imageType).toBeNull();
    expect((await claimRow(b!.id)).image).toBeNull();
    expect((await fresh(second.id)).status).toBe("pending");
  });

  it("a double submit of the same reference for the same order gives one claim", async () => {
    const d = await due();
    const a = await submitTransferClaim(db, d.token, { transferRef: "ABC123456" });
    const b = await submitTransferClaim(db, d.token, { transferRef: "abc 123 456" });
    expect(b!.id).toBe(a!.id);
    expect(b!.flags).toEqual([]);
  });

  it("an unknown token stores nothing", async () => {
    expect(await submitTransferClaim(db, "nope", { transferRef: "ABC123456" })).toBeUndefined();
  });

  it("the reviewer's confirm records who and when, queues one reply, and a second confirm is refused", async () => {
    const d = await due();
    const c = (await submitTransferClaim(db, d.token, { transferRef: "GC0001112223", submittedCentavos: 35000 }))!;
    const r = await decideClaim(db, { workspaceId: owner, actor: { id: operator, role: "operator" }, claimId: c.id, version: 1, decision: "confirm" });
    expect(r.result).toBe("done");
    const after = await fresh(d.id);
    expect(after).toMatchObject({ status: "confirmed", confirmedSource: "transfer", confirmedBy: operator, confirmedClaimId: c.id });
    expect(after.confirmedAt).toBeInstanceOf(Date);
    const sent = await replies(d);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ provider: "unisms", stepId: "ask#confirmed", payload: { to: "+639171234567", message: "Deposit received, see you!" } });
    expect((await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: c.id, version: 2, decision: "confirm" })).result).toBe("conflict");
    expect(await replies(d)).toHaveLength(1);
    expect(await history(d)).toEqual(["requested", "receipt_submitted", "confirmed", "reply_queued"]);
  });

  it("two reviewers deciding the same claim at once: one wins, the other gets a conflict", async () => {
    const d = await due();
    const c = (await submitTransferClaim(db, d.token, { transferRef: "RACE00001" }))!;
    const results = await Promise.all([
      decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: c.id, version: 1, decision: "confirm" }),
      decideClaim(db, { workspaceId: owner, actor: { id: operator, role: "operator" }, claimId: c.id, version: 1, decision: "reject", reason: "Not in our GCash history" }),
    ]);
    expect(results.map((r) => r.result).sort()).toEqual(["conflict", "done"]);
    const row = await claimRow(c.id);
    expect(["confirmed", "rejected"]).toContain(row.status);
    expect((await fresh(d.id)).status).toBe(row.status === "confirmed" ? "confirmed" : "pending");
  });

  it("only the assigned reviewer or the owner decides", async () => {
    const d = await due({ reviewerId: owner });
    const c = (await submitTransferClaim(db, d.token, { transferRef: "ASSIGN0001" }))!;
    expect((await decideClaim(db, { workspaceId: owner, actor: { id: operator, role: "operator" }, claimId: c.id, version: 1, decision: "confirm" })).result).toBe("forbidden");
    const d2 = await due({ reviewerId: operator });
    const c2 = (await submitTransferClaim(db, d2.token, { transferRef: "ASSIGN0002" }))!;
    expect((await decideClaim(db, { workspaceId: owner, actor: { id: operator, role: "operator" }, claimId: c2.id, version: 1, decision: "confirm" })).result).toBe("done");
  });

  it("another workspace cannot see or decide the claim", async () => {
    const d = await due();
    const c = (await submitTransferClaim(db, d.token, { transferRef: "OTHERWS001" }))!;
    expect((await decideClaim(db, { workspaceId: other, actor: { id: other, role: "owner" }, claimId: c.id, version: 1, decision: "confirm" })).result).toBe("not_found");
    expect((await reviewList(db, other)).length).toBe(0);
  });

  it("reject and clarify need a reason, leave the due pending and tell the customer", async () => {
    const d = await due();
    const c = (await submitTransferClaim(db, d.token, { transferRef: "CLARIFY001" }))!;
    expect((await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: c.id, version: 1, decision: "reject", reason: "  " })).result).toBe("reason_needed");
    expect((await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: c.id, version: 1, decision: "clarify", reason: "Please send the full receipt" })).result).toBe("done");
    expect((await claimRow(c.id)).status).toBe("clarify");
    expect((await reviewList(db, owner)).some((r) => r.claimId === c.id)).toBe(true);
    expect((await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: c.id, version: 2, decision: "reject", reason: "No transfer with that reference" })).result).toBe("done");
    expect((await fresh(d.id)).status).toBe("pending");
    const sent = await replies(d);
    expect(sent.map((s) => (s.payload as { message: string }).message)).toEqual([
      `About your payment for ${d.reference}: Please send the full receipt`,
      `We could not confirm your payment for ${d.reference}: No transfer with that reference`,
    ]);
    expect(sent.some((s) => s.stepId === "ask#confirmed")).toBe(false);
  });
});

describe("automatic checkout", () => {
  it("only a matching event confirms, and repeated events give one transition and one reply", async () => {
    const d = await due();
    const p = await checkout(d);
    const pay = await paid(p, 35000, "pay_once");
    await paid(p, 35000, "pay_once");
    await settleCheckout(db, owner, pay.id);
    expect(await fresh(d.id)).toMatchObject({ status: "confirmed", confirmedSource: "checkout", confirmedPaymentId: p.id, confirmedBy: null });
    expect(await replies(d)).toHaveLength(1);
    expect((await history(d)).filter((e) => e === "confirmed")).toHaveLength(1);
  });

  it("a wrong amount goes to review and leaves the due pending", async () => {
    const d = await due();
    const p = await checkout(d);
    await paid(p, 30000);
    expect((await fresh(d.id)).status).toBe("pending");
    const [row] = (await reviewList(db, owner)).filter((r) => r.dueId === d.id);
    expect(row).toMatchObject({ channel: "checkout", amountDue: 35000, submitted: 30000, flags: ["amount_mismatch"] });
    expect(await replies(d)).toHaveLength(0);
  });

  it("a checkout paid after a manual confirmation is flagged paid twice and sends nothing more", async () => {
    const d = await due();
    const p = await checkout(d);
    const c = (await submitTransferClaim(db, d.token, { transferRef: "TWICE00001", submittedCentavos: 35000 }))!;
    await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: c.id, version: 1, decision: "confirm" });
    await paid(p, 35000);
    expect((await fresh(d.id)).confirmedSource).toBe("transfer");
    expect((await reviewList(db, owner)).find((r) => r.dueId === d.id)?.flags).toEqual(["paid_twice"]);
    expect(await replies(d)).toHaveLength(1);
  });

  it("a transfer under review while checkout is pending: the checkout confirms, the claim is flagged and cannot confirm again", async () => {
    const d = await due();
    const p = await checkout(d);
    const c = (await submitTransferClaim(db, d.token, { transferRef: "BOTHPATHS1", submittedCentavos: 35000 }))!;
    await paid(p, 35000);
    expect((await claimRow(c.id)).flags).toEqual(["already_confirmed"]);
    expect((await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: c.id, version: (await claimRow(c.id)).version, decision: "confirm" })).result).toBe("already_confirmed");
    expect(await replies(d)).toHaveLength(1);
  });

  it("a later refund moves the due to refunded, once", async () => {
    const d = await due();
    const p = await checkout(d);
    await paid(p, 35000, "pay_refund_me");
    for (let i = 0; i < 2; i++) {
      await markPaymentRefunded(db, { userId: owner, providerPaymentId: "pay_refund_me", livemode: false });
      await settleCheckout(db, owner, p.id);
    }
    expect((await fresh(d.id)).status).toBe("refunded");
    expect((await history(d)).filter((e) => e === "refunded")).toHaveLength(1);
  });

  it("refunds also apply to a due confirmed from a needs_review claim (S3)", async () => {
    const d = await due();
    const p = await checkout(d);
    // Wrong amount puts the payment in needs_review and creates a review claim.
    await paid(p, 30000, "pay_refund_review");
    const row = (await reviewList(db, owner)).find((r) => r.dueId === d.id)!;
    expect(row.claimId).toBeTruthy();
    await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: row.claimId!, version: row.version!, decision: "confirm" });
    expect((await fresh(d.id)).status).toBe("confirmed");

    const refunded = await markPaymentRefunded(db, { userId: owner, providerPaymentId: "pay_refund_review", livemode: false });
    expect(refunded.changed).toBe(true);
    expect(refunded.payment!.status).toBe("refunded");
    await settleCheckout(db, owner, p.id);
    expect((await fresh(d.id)).status).toBe("refunded");
    expect(await history(d)).toContain("refunded");

    // Out-of-order: refund arrives while claim is still open, then reviewer confirms.
    const d2 = await due();
    const p2 = await checkout(d2);
    await paid(p2, 30000, "pay_refund_early_review");
    const row2 = (await reviewList(db, owner)).find((r) => r.dueId === d2.id)!;
    await markPaymentRefunded(db, { userId: owner, providerPaymentId: "pay_refund_early_review", livemode: false });
    await settleCheckout(db, owner, p2.id);
    expect((await fresh(d2.id)).status).toBe("pending");
    await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: row2.claimId!, version: row2.version!, decision: "confirm" });
    expect((await fresh(d2.id)).status).toBe("refunded");
    expect(await history(d2)).toContain("refunded");
  });
});

describe("expireDue", () => {
  it("cancels a pending due and its checkout once, keeps a confirmed one, and a late payment goes to review", async () => {
    const d = await due();
    const p = await checkout(d);
    const at = { userId: owner, runId: d.runId, stepId: "expire", dueStepId: "ask" };
    expect((await expireDue(db, at)).result).toBe("expired");
    expect((await expireDue(db, at)).result).toBe("expired");
    expect((await fresh(d.id)).status).toBe("cancelled");
    expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0]!.status).toBe("expired");
    await paid(p, 35000);
    expect((await reviewList(db, owner)).find((r) => r.dueId === d.id)?.flags).toEqual(["late_payment"]);

    const kept = await due();
    const c = (await submitTransferClaim(db, kept.token, { transferRef: "KEEPME0001" }))!;
    await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: c.id, version: 1, decision: "confirm" });
    expect((await expireDue(db, { userId: owner, runId: kept.runId, stepId: "expire", dueStepId: "ask" })).result).toBe("kept");
    expect((await fresh(kept.id)).status).toBe("confirmed");
  });
});

describe("reply state is separate from payment state", () => {
  it("a failed reply shows in the list and Retry reply re-queues only the reply", async () => {
    const d = await due();
    const c = (await submitTransferClaim(db, d.token, { transferRef: "REPLYFAIL1" }))!;
    await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: c.id, version: 1, decision: "confirm" });
    await db.update(deliveries).set({ state: "failed", lastError: "UniSMS refused" }).where(and(eq(deliveries.runId, d.runId), eq(deliveries.stepId, "ask#confirmed")));
    const row = (await reviewList(db, owner)).find((r) => r.dueId === d.id && r.type === "reply");
    expect(row).toMatchObject({ replyState: "failed", dueStatus: "confirmed" });
    expect(await retryReply(db, owner, d.id)).toBe(true);
    expect(await retryReply(db, owner, d.id)).toBe(false);
    expect((await replies(d))[0]!.state).toBe("queued");
    expect((await fresh(d.id)).status).toBe("confirmed");
    expect(await retryReply(db, other, d.id)).toBe(false);
  });
});

describe("deposits and balances on a booking", () => {
  it("a confirmed deposit leaves the balance outstanding, and a pay-later booking owes it all", async () => {
    const deposit = await due({ reference: "D-DEP1", totalCentavos: 120000 });
    const c = (await submitTransferClaim(db, deposit.token, { transferRef: "DEPOSIT001", submittedCentavos: 35000 }))!;
    await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: c.id, version: 1, decision: "confirm" });
    const [dep] = await duesForBooking(db, owner, { reference: "D-DEP1" });
    expect(dep).toMatchObject({ kind: "deposit", status: "confirmed", amount: 35000, outstanding: 85000, confirmedSource: "transfer", confirmedBy: "seller@test.local" });
    expect(dep!.history.map((h) => h.event)).toEqual(["requested", "receipt_submitted", "confirmed", "reply_queued"]);

    await due({ reference: "D-LATER", kind: "balance", amountCentavos: 120000 });
    const [bal] = await duesForBooking(db, owner, { reference: "D-LATER" });
    expect(bal).toMatchObject({ kind: "balance", status: "pending", outstanding: 120000 });
    expect(await duesForBooking(db, other, { reference: "D-LATER" })).toEqual([]);
  });
});

describe("DM receipt claims and open_due_id lifecycle (C6)", () => {
  it("extracts transfer references and explicit peso amounts from DM captions without false positives", () => {
    expect(extractDmReceiptRef("Ref: 5012 3456 7890")).toBe("5012 3456 7890");
    expect(extractDmReceiptRef("GCash ref# 1002-5555-8888 paid")).toBe("1002-5555-8888");
    expect(extractDmReceiptRef("Reference number: GC0001112223")).toBe("GC0001112223");
    expect(extractDmReceiptRef("5012 3456 7890")).toBe("5012 3456 7890");
    expect(extractDmReceiptRef("ABC123456")).toBe("ABC123456");
    expect(extractDmReceiptRef("Here is my receipt 5012 3456 7890")).toBe("5012 3456 7890");
    expect(extractDmReceiptRef("Call me at 0917 555 1234")).toBeNull();
    expect(extractDmReceiptRef("Dec 20 to 22, 2 adults")).toBeNull();
    expect(extractDmReceiptRef("Paid!")).toBeNull();

    expect(extractDmReceiptAmount("Paid PHP 350.00")).toBe(35000);
    expect(extractDmReceiptAmount("Sent ₱1,500.50")).toBe(150050);
    expect(extractDmReceiptAmount("P300 ref 501234567890")).toBe(30000);
    expect(extractDmReceiptAmount("350 pesos")).toBe(35000);
    expect(extractDmReceiptAmount("Dec 20, 2 adults")).toBeNull();
  });

  it("links open_due_id on createDue and clears it when confirmed manually, via checkout, or expired", async () => {
    const conv = async (ext: string) =>
      (await db.insert(conversations).values({ userId: owner, channel: "messenger", externalId: ext }).returning())[0]!;
    const readOpen = async (id: string) => (await db.select({ openDueId: conversations.openDueId }).from(conversations).where(eq(conversations.id, id)))[0]!.openDueId;

    // 1. Manual confirm clears open_due_id.
    const c1 = await conv("psid-c6-confirm");
    const d1 = await due({ conversationId: c1.id });
    expect(await readOpen(c1.id)).toBe(d1.id);
    const claim = (await submitDmReceiptClaim(db, { userId: owner, dueId: d1.id, sourceMid: "mid_dm_confirm_1", channel: "messenger", caption: "Ref 8800112233", image: { bytes: PNG } }))!;
    expect(claim.status).toBe("open");
    expect((await fresh(d1.id)).status).toBe("pending");
    await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: claim.id, version: 1, decision: "confirm" });
    expect(await readOpen(c1.id)).toBeNull();

    // 2. PayMongo checkout settle clears open_due_id.
    const c2 = await conv("psid-c6-checkout");
    const d2 = await due({ conversationId: c2.id });
    expect(await readOpen(c2.id)).toBe(d2.id);
    const p2 = await checkout(d2);
    await paid(p2, 35000);
    expect(await readOpen(c2.id)).toBeNull();

    // 3. expireDue clears open_due_id.
    const c3 = await conv("psid-c6-expire");
    const d3 = await due({ conversationId: c3.id });
    expect(await readOpen(c3.id)).toBe(d3.id);
    await expireDue(db, { userId: owner, runId: d3.runId, stepId: "expire", dueStepId: "ask" });
    expect(await readOpen(c3.id)).toBeNull();

    // 4. Test due never sets open_due_id.
    const c4 = await conv("psid-c6-test");
    await due({ conversationId: c4.id, test: true });
    expect(await readOpen(c4.id)).toBeNull();
  });

  it("creates one claim per mid, flags duplicate references and amount mismatches, never marks paid, and ignores closed dues", async () => {
    const first = await due();
    await db.insert(receiptReferences).values({ userId: owner, normalizedRef: "REUSED998877", firstRunId: first.runId });

    const d = await due();
    const a = (await submitDmReceiptClaim(db, { userId: owner, dueId: d.id, sourceMid: "mid_dm_dup_1", channel: "messenger", caption: "Paid PHP 300 ref REUSED-998877", image: { bytes: PNG } }))!;
    expect(a.flags.sort()).toEqual(["amount_mismatch", "duplicate_reference"]);
    expect(a.transferRef).toBe("REUSED-998877");
    expect(a.submittedCentavos).toBe(30000);
    expect(a.imageType).toBe("png");
    expect((await fresh(d.id)).status).toBe("pending");
    expect((await reviewList(db, owner)).some((r) => r.claimId === a.id && r.hasImage)).toBe(true);

    // Replaying the same mid returns the same claim and inserts no second row.
    const replay = (await submitDmReceiptClaim(db, { userId: owner, dueId: d.id, sourceMid: "mid_dm_dup_1", channel: "messenger", caption: "Paid PHP 300 ref REUSED-998877", image: { bytes: PNG } }))!;
    expect(replay.id).toBe(a.id);
    expect(await db.select().from(paymentClaims).where(eq(paymentClaims.dueId, d.id))).toHaveLength(1);

    // Confirm the due, then another DM photo with a new mid creates NO claim.
    await decideClaim(db, { workspaceId: owner, actor: asOwner, claimId: a.id, version: 1, decision: "confirm" });
    expect(await submitDmReceiptClaim(db, { userId: owner, dueId: d.id, sourceMid: "mid_dm_after_confirm", channel: "messenger", image: { bytes: PNG } })).toBeUndefined();

    // Expired due also creates NO claim.
    const exp = await due();
    await expireDue(db, { userId: owner, runId: exp.runId, stepId: "expire", dueStepId: "ask" });
    expect(await submitDmReceiptClaim(db, { userId: owner, dueId: exp.id, sourceMid: "mid_dm_after_expire", channel: "messenger", image: { bytes: PNG } })).toBeUndefined();
  });
});
