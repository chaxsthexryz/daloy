import { randomBytes } from "node:crypto";
import { connections, mailSenders, users, type Db, type MailDeps, type Provider } from "@daloy/db";
import { and, eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../test/db";
import { startFakeSmtp } from "../../../test/fake-smtp";
import { alertBrokenGrants } from "./connection-alerts";

// Plan R8 and open question 10: one email per broken OAuth grant per day, to the workspace owner, through the installation's server.
const key = randomBytes(32);
const at = (s: string) => new Date(`${s}Z`);
let db: Db;
let pool: Pool;
let smtp: Awaited<ReturnType<typeof startFakeSmtp>>;
let seq = 0;

const mail = (port = smtp.port): MailDeps => ({
  installation: { transport: nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true }), from: "Daloy <daloy@localhost>" },
  gmail: () => {
    throw new Error("not used");
  },
  sharedMail: "approved",
});
const tick = (now: Date, deps = mail()) => alertBrokenGrants({ db, mail: deps, secretsKey: key, publicUrl: "https://daloy.example.com", now });
const sent = (to: string) => smtp.messages.filter((m) => m.to.includes(to)).map((m) => ({ ...m, raw: m.raw.replace(/=\r?\n/g, "") }));

async function owner(language: "en" | "tl" = "en") {
  const email = `ca${++seq}@test.local`;
  const [u] = await db.insert(users).values({ email, passwordHash: "x", language }).returning();
  return { id: u!.id, email };
}
const grant = (userId: string, provider: Provider, status: "active" | "failed", authMethod: "oauth" | "token" = "oauth") =>
  db.insert(connections).values({ userId, provider, status, account: "a", credentialCiphertext: "c", credentialIv: `iv${++seq}`, credentialAuthTag: "t", authMethod, lastError: "secret provider text" });
const alertAt = async (userId: string, provider: Provider) => (await db.select({ at: connections.alertAt }).from(connections).where(and(eq(connections.userId, userId), eq(connections.provider, provider))))[0]!.at;

beforeAll(async () => {
  ({ db, pool } = await freshDatabase());
  smtp = await startFakeSmtp();
}, 120_000);
afterAll(async () => {
  await pool?.end();
  smtp?.close();
});

describe("broken grant alerts", () => {
  it("emails the owner once a day about a failed OAuth connection, with a link to Apps and no provider text", async () => {
    const o = await owner();
    await grant(o.id, "slack", "failed");
    await tick(at("2026-11-20T08:00:00"));
    await tick(at("2026-11-20T20:00:00"));
    const first = sent(o.email);
    expect(first).toHaveLength(1);
    expect(first[0]!.raw).toContain("Reconnect Slack");
    expect(first[0]!.raw).toContain("https://daloy.example.com/#/apps");
    expect(first[0]!.raw).not.toContain("secret provider text");
    await tick(at("2026-11-21T08:30:00"));
    expect(sent(o.email)).toHaveLength(2);
  });

  it("does not email about a working grant or a failed pasted token", async () => {
    const o = await owner();
    await grant(o.id, "trello", "active");
    await grant(o.id, "airtable", "failed", "token");
    await tick(at("2026-11-20T08:00:00"));
    expect(sent(o.email)).toHaveLength(0);
  });

  it("emails about a failed Gmail sign-in through the installation's server, since the owner's Gmail cannot send it", async () => {
    const o = await owner("tl");
    await db.insert(mailSenders).values({ userId: o.id, address: `x${seq}@gmail.test`, status: "failed", authMethod: "oauth", externalId: "sub" });
    await tick(at("2026-11-20T08:00:00"));
    const got = sent(o.email);
    expect(got).toHaveLength(1);
    expect(got[0]!.raw).toContain("I-reconnect ang Gmail");
    await tick(at("2026-11-20T09:00:00"));
    expect(sent(o.email)).toHaveLength(1);
  });

  it("gives the day's claim back when the email cannot be sent, so the next check tries again", async () => {
    const o = await owner();
    await grant(o.id, "notion", "failed");
    await tick(at("2026-11-20T08:00:00"), mail(1));
    expect(await alertAt(o.id, "notion")).toBeNull();
    await tick(at("2026-11-20T08:01:00"));
    expect(sent(o.email)).toHaveLength(1);
  });

  it("sends one email when two workers check at the same moment", async () => {
    const o = await owner();
    await grant(o.id, "outlook", "failed");
    await Promise.all([tick(at("2026-11-20T08:00:00")), tick(at("2026-11-20T08:00:00"))]);
    expect(sent(o.email)).toHaveLength(1);
  });
});
