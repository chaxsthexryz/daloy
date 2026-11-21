import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import type { Db } from "./index";
import { createDue } from "./payment-review";
import { matcher, normalizePhone, purgeReceiptImages } from "./privacy";
import { paymentClaims, paymentDues, paymentSettings, runs, users, workflows, workflowVersions } from "./schema";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const DAY = 86_400_000;
const NOW = new Date("2031-06-01T00:00:00Z");
let db: Db;
let pool: Pool;
let n = 0;

beforeAll(async () => ({ db, pool } = await freshDatabase()), 120_000);
afterAll(() => pool?.end());

async function workspace(retention?: number) {
  const [u] = await db.insert(users).values({ email: `p${++n}@test.local`, passwordHash: "x" }).returning();
  if (retention) await db.insert(paymentSettings).values({ userId: u!.id, receiptRetentionDays: retention });
  const [wf] = await db.insert(workflows).values({ userId: u!.id, name: "W", slug: `w${n}` }).returning();
  const [v] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition: {} }).returning();
  return { id: u!.id, wf: wf!.id, version: v!.id };
}

/** A due in the given state, last changed daysAgo days before NOW, with one receipt image on a claim. */
async function claim(w: Awaited<ReturnType<typeof workspace>>, status: "pending" | "confirmed" | "cancelled" | "refunded", daysAgo: number) {
  const [r] = await db.insert(runs).values({ workflowVersionId: w.version }).returning();
  const d = await createDue(db, { userId: w.id, test: false, workflowId: w.wf, runId: r!.id, stepId: "ask", reference: `D-${++n}`, kind: "deposit", amountCentavos: 1000 });
  const closed = status === "confirmed" || status === "refunded" ? { confirmedSource: "transfer" as const, confirmedAt: NOW } : {};
  await db.update(paymentDues).set({ status, ...closed, updatedAt: new Date(NOW.getTime() - daysAgo * DAY) }).where(eq(paymentDues.id, d.id));
  const [c] = await db.insert(paymentClaims).values({ userId: w.id, dueId: d.id, channel: "transfer", transferRef: `R${n}`, image: PNG, imageType: "png", imageSize: PNG.length }).returning();
  return c!.id;
}
const hasImage = async (id: string) => (await db.select().from(paymentClaims).where(eq(paymentClaims.id, id)))[0]!.image !== null;

describe("receipt image retention", () => {
  it("clears images of dues closed past 90 days with no settings row, keeps newer and open ones", async () => {
    const w = await workspace();
    const old = await claim(w, "confirmed", 91);
    const recent = await claim(w, "cancelled", 89);
    const open = await claim(w, "pending", 200);
    expect(await purgeReceiptImages(db, NOW)).toBeGreaterThanOrEqual(1);
    expect(await hasImage(old)).toBe(false);
    expect(await hasImage(recent)).toBe(true);
    expect(await hasImage(open)).toBe(true);
    const [row] = await db.select().from(paymentClaims).where(eq(paymentClaims.id, old));
    expect(row).toMatchObject({ imageType: null, imageSize: null, transferRef: expect.any(String) });
  });

  it("uses the workspace's own days and covers refunded dues", async () => {
    const w = await workspace(10);
    const gone = await claim(w, "refunded", 11);
    const kept = await claim(w, "confirmed", 9);
    await purgeReceiptImages(db, NOW);
    expect(await hasImage(gone)).toBe(false);
    expect(await hasImage(kept)).toBe(true);
  });

  it("works through a batch limit", async () => {
    const w = await workspace(1);
    const ids = [await claim(w, "confirmed", 5), await claim(w, "confirmed", 5), await claim(w, "confirmed", 5)];
    expect(await purgeReceiptImages(db, NOW, 2)).toBe(2);
    expect(await purgeReceiptImages(db, NOW, 2)).toBe(1);
    for (const id of ids) expect(await hasImage(id)).toBe(false);
  });

  it("refuses retention outside 1 to 3650", async () => {
    const w = await workspace();
    await expect(db.insert(paymentSettings).values({ userId: w.id, receiptRetentionDays: 0 })).rejects.toThrow();
    await expect(db.insert(paymentSettings).values({ userId: w.id, receiptRetentionDays: 3651 })).rejects.toThrow();
  });
});

describe("matching", () => {
  it("reads Philippine numbers in every common form", () => {
    for (const s of ["0917 123 4567", "+639171234567", "639171234567", "+63 917-123-4567", "9171234567"]) expect(normalizePhone(s)).toBe("9171234567");
    for (const s of ["12345", "02 8123 4567", "hello", "09171234"]) expect(normalizePhone(s)).toBeNull();
  });
  it("finds the email or phone in nested values and not in others", () => {
    const m = matcher({ phone: "09171234567" });
    expect(m({ a: [{ b: "+63 917 123 4567" }] })).toBe(true);
    expect(m({ a: "0918 111 2222" })).toBe(false);
    expect(matcher({ email: "Ana@X.test" })({ a: { b: ["mail ana@x.TEST please"] } })).toBe(true);
    expect(matcher({ email: "ana@x.test" })({ a: "ben@x.test", n: 5, z: null })).toBe(false);
  });
  it("matches an email as a whole address, not as part of a longer one", () => {
    const m = matcher({ email: "maria@gmail.com" });
    expect(m("Email: Maria@Gmail.com, thanks")).toBe(true);
    expect(m("<maria@gmail.com>")).toBe(true);
    expect(m("maria@gmail.com.")).toBe(true);
    expect(m("annamaria@gmail.com")).toBe(false);
    expect(m("maria@gmail.com.ph")).toBe(false);
    expect(m("maria@gmail.company")).toBe(false);
  });
  it("finds a phone inside text and a list, but not inside a longer digit run", () => {
    const m = matcher({ phone: "09171234567" });
    expect(m("Order 3, call 0917 123 4567")).toBe(true);
    expect(m("09181112222 / 09171234567")).toBe(true);
    expect(m("1209171234567")).toBe(false);
    expect(m("09171234567 / 09181112222")).toBe(true);
    expect(matcher({ phone: "09181112222" })("09171234567 / 09181112222")).toBe(true);
    expect(m(9171234567)).toBe(true);
  });
});
