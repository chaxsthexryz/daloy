import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { cycleStart, manilaDay, nextCycleStart, claimUsage, planOf, PLANS, QuotaError, usageSummary } from "./usage";
import { usageClaims, usageCounts, users, workflows, workflowVersions } from "./schema";
import type { Db } from "./index";

describe("cycleStart", () => {
  it("is the monthly anniversary on or before today", () => {
    expect(cycleStart("2026-11-17", "2026-11-17")).toBe("2026-11-17");
    expect(cycleStart("2026-11-17", "2026-12-16")).toBe("2026-11-17");
    expect(cycleStart("2026-11-17", "2026-12-17")).toBe("2026-12-17");
    expect(cycleStart("2026-11-17", "2027-03-01")).toBe("2027-02-17");
    expect(nextCycleStart("2026-11-17", "2026-12-16")).toBe("2026-12-17");
    expect(nextCycleStart("2026-12-17", "2026-12-17")).toBe("2027-01-17");
  });

  it("resets on the last day of shorter months when the start is on the 31st", () => {
    expect(cycleStart("2026-01-31", "2026-02-27")).toBe("2026-01-31");
    expect(cycleStart("2026-01-31", "2026-02-28")).toBe("2026-02-28");
    expect(cycleStart("2026-01-31", "2026-03-30")).toBe("2026-02-28");
    expect(cycleStart("2026-01-31", "2026-03-31")).toBe("2026-03-31");
    expect(cycleStart("2026-01-31", "2026-05-01")).toBe("2026-04-30");
    expect(nextCycleStart("2026-01-31", "2026-01-31")).toBe("2026-02-28");
  });

  it("knows leap years", () => {
    expect(cycleStart("2027-12-31", "2028-02-29")).toBe("2028-02-29");
    expect(nextCycleStart("2027-12-31", "2028-01-31")).toBe("2028-02-29");
    expect(nextCycleStart("2028-01-31", "2028-02-29")).toBe("2028-03-31");
  });

  it("treats a start in the future as the cycle that begins then", () => {
    expect(cycleStart("2026-12-01", "2026-11-17")).toBe("2026-12-01");
    expect(nextCycleStart("2026-12-01", "2026-11-17")).toBe("2027-01-01");
  });

  it("crosses a year", () => {
    expect(cycleStart("2026-12-15", "2027-01-14")).toBe("2026-12-15");
    expect(cycleStart("2026-12-15", "2027-01-15")).toBe("2027-01-15");
  });
});

describe("manilaDay", () => {
  it("is the calendar date in Manila, eight hours ahead of UTC", () => {
    expect(manilaDay(new Date("2026-12-16T15:59:59Z"))).toBe("2026-12-16");
    expect(manilaDay(new Date("2026-12-16T16:00:00Z"))).toBe("2026-12-17");
  });
});

describe("usage", () => {
  let db: Db;
  let pool: Pool;
  let seq = 0;
  const noon = new Date("2026-11-17T04:00:00Z");
  const newUser = async (plan: keyof typeof PLANS | null = "pilot", planStartedOn: string | null = null) =>
    (await db.insert(users).values({ email: `u${++seq}@test.local`, passwordHash: "x", plan, planStartedOn }).returning())[0]!.id;
  const used = async (userId: string, kind: string) => (await db.select().from(usageCounts).where(eq(usageCounts.userId, userId))).filter((r) => r.kind === kind).map((r) => `${r.period}:${r.used}`);

  beforeAll(async () => {
    ({ db, pool } = await freshDatabase());
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
  });

  it("holds the limit exactly and says so in plain words", async () => {
    const u = await newUser();
    await claimUsage(db, u, "email", { n: 100, now: noon });
    const err = await claimUsage(db, u, "email", { now: noon }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaError);
    expect(err).toMatchObject({ retryable: false, outcome: "not_sent", kind: "email" });
    expect((err as Error).message).toContain("today's limit of 100 email recipients");
    expect(await used(u, "email")).toEqual(["2026-11-17:100"]);
    // One claim bigger than the limit never counts, even on a fresh day.
    await expect(claimUsage(db, u, "email", { n: 101, now: new Date("2026-11-18T04:00:00Z") })).rejects.toBeInstanceOf(QuotaError);
    expect(await used(u, "email")).toEqual(["2026-11-17:100"]);
  });

  it("lets exactly one of two concurrent claims take the last unit", async () => {
    const u = await newUser();
    await claimUsage(db, u, "http", { n: 199, now: noon });
    const results = await Promise.allSettled([claimUsage(db, u, "http", { now: noon }), claimUsage(db, u, "http", { now: noon })]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await used(u, "http")).toEqual(["2026-11-17:200"]);
  });

  it("counts a key once and does not throw for a retried step at the limit", async () => {
    const u = await newUser();
    await claimUsage(db, u, "email", { n: 100, key: "run1:step", now: noon });
    await claimUsage(db, u, "email", { n: 100, key: "run1:step", now: noon });
    expect(await used(u, "email")).toEqual(["2026-11-17:100"]);
  });

  it("leaves no key behind when the claim is refused", async () => {
    const u = await newUser();
    await claimUsage(db, u, "email", { n: 100, now: noon });
    await expect(claimUsage(db, u, "email", { key: "k", now: noon })).rejects.toBeInstanceOf(QuotaError);
    expect(await db.select().from(usageClaims).where(eq(usageClaims.userId, u))).toEqual([]);
    await db.update(users).set({ plan: "business" }).where(eq(users.id, u));
    await claimUsage(db, u, "email", { key: "k", now: noon });
    expect(await used(u, "email")).toEqual(["2026-11-17:101"]);
  });

  it("counts without a limit when there is no plan", async () => {
    const u = await newUser(null);
    await claimUsage(db, u, "email", { n: 5000, now: noon });
    await claimUsage(db, u, "ai", { n: 5000, now: noon });
    expect(await used(u, "email")).toEqual(["2026-11-17:5000"]);
    expect(await planOf(db, u)).toEqual({ plan: null, startedOn: null });
  });

  it("starts a fresh counter each Manila day and each monthly cycle", async () => {
    const u = await newUser("pilot", "2026-10-20");
    await claimUsage(db, u, "email", { n: 100, now: noon });
    await claimUsage(db, u, "email", { n: 100, now: new Date("2026-11-17T16:00:00Z") });
    expect(await used(u, "email")).toEqual(["2026-11-17:100", "2026-11-18:100"]);
    await claimUsage(db, u, "ai", { n: 100, now: new Date("2026-11-19T04:00:00Z") });
    await expect(claimUsage(db, u, "ai", { now: new Date("2026-11-19T04:00:00Z") })).rejects.toThrow(/They come back on 20 November/);
    await claimUsage(db, u, "ai", { now: new Date("2026-11-20T04:00:00Z") });
    expect(await used(u, "ai")).toEqual(["2026-10-20:100", "2026-11-20:1"]);
  });

  it("uses the first of the Manila month for AI when no start date is set", async () => {
    const u = await newUser("pilot", null);
    await claimUsage(db, u, "ai", { now: noon });
    expect(await used(u, "ai")).toEqual(["2026-11-01:1"]);
  });

  it("summarises limits, resets and live automations", async () => {
    const u = await newUser("business", "2026-10-20");
    await claimUsage(db, u, "ai", { n: 7, now: noon });
    await claimUsage(db, u, "email", { n: 3, now: noon });
    const [a] = await db.insert(workflows).values({ userId: u, name: "A", slug: "a" }).returning();
    const [b] = await db.insert(workflows).values({ userId: u, name: "B", slug: "b" }).returning();
    await db.insert(workflowVersions).values([
      { workflowId: a!.id, version: 1, definition: {}, published: true },
      { workflowId: a!.id, version: 2, definition: {}, published: true },
      { workflowId: b!.id, version: 1, definition: {}, published: false },
    ]);
    expect(await usageSummary(db, u, noon)).toEqual({
      plan: "business",
      label: "Business",
      limits: PLANS.business,
      ai: { used: 7, limit: 500, resetsOn: "2026-11-20" },
      email: { used: 3, limit: 300, resetsOn: "2026-11-18" },
      http: { used: 0, limit: 1000, resetsOn: "2026-11-18" },
      automations: { live: 1, limit: 5 },
      minScheduleMinutes: 15,
    });
    const none = await newUser(null);
    expect(await usageSummary(db, none, noon)).toMatchObject({ plan: null, label: null, limits: null, ai: { used: 0, limit: null }, automations: { live: 0, limit: null }, minScheduleMinutes: null });
  });
});
