import { randomBytes } from "node:crypto";
import { createRun, runs, users, workflows, workflowVersions, type Db, type MailDeps } from "@daloy/db";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeSmtp } from "../../../test/fake-smtp";
import { checkSchedules, lastDue } from "./watchdog";

// Roadmap phase N17: a scheduled automation that misses its fire is flagged once, emailed at most once a day, and cleared by the next scheduled run.
const key = randomBytes(32);
const at = (s: string) => new Date(`${s}Z`);
const DAILY = "0 9 * * *";
let db: Db;
let pool: Pool;
let smtp: Awaited<ReturnType<typeof startFakeSmtp>>;
let seq = 0;

const mail = (): MailDeps => ({
  installation: { transport: nodemailer.createTransport({ host: "127.0.0.1", port: smtp.port, secure: false, ignoreTLS: true }), from: "Daloy <daloy@localhost>" },
  gmail: () => { throw new Error("not used"); },
  sharedMail: "open",
});
const tick = (now: Date, deps = mail()) => checkSchedules({ db, mail: deps, secretsKey: key, publicUrl: "https://daloy.example.com", now });
// The body is quoted-printable: join its soft line breaks so a sentence can be matched.
const sent = (to: string) => smtp.messages.filter((m) => m.to.includes(to)).map((m) => ({ ...m, raw: m.raw.replace(/=\r?\n/g, "") }));

/** A workspace with one automation whose live version, published at `publishedAt`, runs on `cron`. */
async function scheduled(opts: { cron?: string; publishedAt?: string; language?: "en" | "tl"; live?: boolean } = {}) {
  const n = ++seq;
  const [user] = await db.insert(users).values({ email: `w${n}@test.local`, passwordHash: "x", language: opts.language ?? "en" }).returning();
  const [wf] = await db.insert(workflows).values({ userId: user!.id, name: `Daily report ${n}`, slug: `w${n}` }).returning();
  const definition = { trigger: { type: "schedule", config: { cron: opts.cron ?? DAILY } }, steps: [{ id: "a", type: "condition", config: { condition: "true" } }] };
  const [version] = await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, definition, published: opts.live ?? true, createdAt: at(opts.publishedAt ?? "2026-11-10T00:00:00") }).returning();
  return { id: wf!.id, email: `w${n}@test.local`, versionId: version!.id };
}
const flag = async (id: string) => (await db.select({ at: workflows.scheduleMissedAt }).from(workflows).where(eq(workflows.id, id)))[0]!.at;
const fire = async (versionId: string, when: string, payload: object = { firedAt: when }) => {
  const id = await createRun(db, versionId, payload);
  await db.update(runs).set({ createdAt: at(when) }).where(eq(runs.id, id));
};

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  smtp = await startFakeSmtp();
}, 120_000);
afterAll(async () => {
  await pool?.end();
  smtp?.close();
});

describe("lastDue", () => {
  it("is the latest cron time at least 15 minutes old", () => {
    expect(lastDue(DAILY, at("2026-11-18T09:20:00"))).toEqual(at("2026-11-18T09:00:00"));
    expect(lastDue(DAILY, at("2026-11-18T09:10:00"))).toEqual(at("2026-11-17T09:00:00"));
  });
  it("is null for a cron that does not parse", () => {
    expect(lastDue("not a cron", at("2026-11-18T09:20:00"))).toBeNull();
  });
});

describe("schedule watchdog", () => {
  it("does not flag a schedule still inside its grace period", async () => {
    const w = await scheduled({ cron: DAILY });
    await fire(w.versionId, "2026-11-17T09:00:00");
    await tick(at("2026-11-18T09:10:00"));
    expect(await flag(w.id)).toBeNull();
  });

  it("flags a missed fire once and sends one email to the owner", async () => {
    const w = await scheduled();
    await tick(at("2026-11-18T09:20:00"));
    expect(await flag(w.id)).not.toBeNull();
    expect(sent(w.email)).toHaveLength(1);
    expect(sent(w.email)[0]!.raw).toContain("did not run when it was due");
    expect(sent(w.email)[0]!.raw).toContain(`https://daloy.example.com/#/w/${w.id}`);
    await tick(at("2026-11-18T09:25:00"));
    await tick(at("2026-11-18T10:25:00"));
    expect(sent(w.email)).toHaveLength(1);
  });

  it("does not count a manual run as the fire", async () => {
    const w = await scheduled();
    await fire(w.versionId, "2026-11-18T09:05:00", {});
    await tick(at("2026-11-18T09:20:00"));
    expect(await flag(w.id)).not.toBeNull();
  });

  it("clears the flag after the next scheduled run, and emails again a day later", async () => {
    const w = await scheduled();
    await tick(at("2026-11-18T09:20:00"));
    await fire(w.versionId, "2026-11-18T09:30:00");
    await tick(at("2026-11-18T09:40:00"));
    expect(await flag(w.id)).toBeNull();
    // Missing the next fire flags it again, but the owner was already told within a day.
    await tick(at("2026-11-19T09:25:00"));
    expect(await flag(w.id)).not.toBeNull();
    expect(sent(w.email)).toHaveLength(2);
  });

  it("sends at most one email per day even when the flag clears and returns", async () => {
    const w = await scheduled({ cron: "0 * * * *" });
    await tick(at("2026-11-18T09:20:00"));
    await fire(w.versionId, "2026-11-18T10:00:00");
    await tick(at("2026-11-18T10:20:00"));
    expect(await flag(w.id)).toBeNull();
    await tick(at("2026-11-18T11:20:00"));
    expect(await flag(w.id)).not.toBeNull();
    expect(sent(w.email)).toHaveLength(1);
  });

  it("does not blame a version published after the due fire", async () => {
    const w = await scheduled({ publishedAt: "2026-11-18T09:10:00" });
    await tick(at("2026-11-18T09:30:00"));
    expect(await flag(w.id)).toBeNull();
  });

  it("clears the flag when the automation is turned off", async () => {
    const w = await scheduled();
    await tick(at("2026-11-18T09:20:00"));
    await db.update(workflowVersions).set({ published: false }).where(eq(workflowVersions.id, w.versionId));
    await tick(at("2026-11-18T09:30:00"));
    expect(await flag(w.id)).toBeNull();
  });

  it("writes the email in Tagalog for a Tagalog workspace", async () => {
    const w = await scheduled({ language: "tl" });
    await tick(at("2026-11-18T09:20:00"));
    expect(sent(w.email)[0]!.raw).toContain("Hindi tumakbo sa itinakdang oras");
  });

  it("retries the email on the next tick when the send fails", async () => {
    const w = await scheduled();
    const broken: MailDeps = { ...mail(), installation: { transport: nodemailer.createTransport({ host: "127.0.0.1", port: 1, secure: false, ignoreTLS: true }), from: "Daloy <daloy@localhost>" } };
    await tick(at("2026-11-18T09:20:00"), broken);
    expect(sent(w.email)).toHaveLength(0);
    await tick(at("2026-11-18T09:21:00"));
    expect(sent(w.email)).toHaveLength(1);
  });

  it("sends one email when two workers check at once", async () => {
    const w = await scheduled();
    await Promise.all([tick(at("2026-11-18T09:20:00")), tick(at("2026-11-18T09:20:00"))]);
    expect(sent(w.email)).toHaveLength(1);
  });
});
