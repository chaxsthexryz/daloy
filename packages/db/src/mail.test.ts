import { randomBytes } from "node:crypto";
import nodemailer, { type SendMailOptions } from "nodemailer";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeSmtp } from "../../../test/fake-smtp";
import { freshDatabase } from "../../../test/db";
import type { Db } from "./index";
import { sendAs, sendEmail, type MailDeps, type Mailer } from "./mail";
import { claimVerifyToken, connectGmail, issueVerifyToken, readSender, saveProfile } from "./mail-senders";
import { users } from "./schema";

// jsonTransport builds the full message without sending it, so the test can read what would go out.
const mailer: Mailer = { transport: nodemailer.createTransport({ jsonTransport: true }), from: "Daloy <daloy@example.com>" };
const email = (to: string) => ({ to, subject: "New inquiry", text: "Hello" });

describe("sendEmail", () => {
  it("sends plain text with a message id built from the idempotency key", async () => {
    const out = await sendEmail(mailer, email("ana@example.com, ben@example.com"), "run-1:notify:2");
    expect(out.to).toEqual(["ana@example.com", "ben@example.com"]);
    expect(out.messageId).toBe("<run-1.notify.2@daloy>");
    const sent = JSON.parse(out.raw!) as { to: { address: string }[]; subject: string; text: string; html?: string; messageId: string };
    expect(sent.to.map((t) => t.address)).toEqual(["ana@example.com", "ben@example.com"]);
    expect(sent).toMatchObject({ subject: "New inquiry", text: "Hello", messageId: "<run-1.notify.2@daloy>" });
    expect(sent.html).toBeUndefined();
  });

  it("refuses invalid addresses, an empty list and more than 10 recipients without retrying", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `u${i}@example.com`).join(",");
    for (const to of ["not-an-email", "a@example.com, b@", " , ", eleven, "a@example.com\r\nBcc: x@example.com"]) {
      await expect(sendEmail(mailer, email(to), "k"), to).rejects.toMatchObject({ retryable: false });
    }
  });

  it("retries temporary SMTP failures but not permanent ones", async () => {
    const failing = (responseCode: number): Mailer => ({
      from: "d@example.com",
      transport: { sendMail: async () => Promise.reject(Object.assign(new Error("smtp"), { responseCode })) } as unknown as Mailer["transport"],
    });
    await expect(sendEmail(failing(451), email("a@example.com"), "k")).rejects.toMatchObject({ retryable: true });
    await expect(sendEmail(failing(550), email("a@example.com"), "k")).rejects.toMatchObject({ retryable: false });
  });
});

describe("sendAs", () => {
  let db: Db;
  let pool: Pool;
  let gmail: Awaited<ReturnType<typeof startFakeSmtp>>;
  const key = randomBytes(32);
  const installation: string[] = [];
  let seq = 0;
  const deps = (): MailDeps => ({
    installation: {
      from: "Daloy <daloy@localhost>",
      transport: {
        sendMail: async (msg: SendMailOptions) => {
          const info = await nodemailer.createTransport({ jsonTransport: true }).sendMail(msg);
          installation.push(String(info.message));
          return info;
        },
      } as unknown as Mailer["transport"],
    },
    // The fake stands in for smtp.gmail.com:465; only host, port and TLS differ from the real transport.
    gmail: (auth) => nodemailer.createTransport({ host: "127.0.0.1", port: gmail.port, secure: false, ignoreTLS: true, auth }),
  });
  const owner = async () => (await db.insert(users).values({ email: `send${++seq}@test.local`, passwordHash: "x" }).returning())[0]!.id;
  const connect = async (userId: string, address: string, appPassword: string) => {
    await connectGmail(db, key, userId, { address, appPassword });
    await claimVerifyToken(db, userId, await issueVerifyToken(db, userId));
  };
  const mail = { to: "customer@example.com", subject: "Thanks", text: "We got it." };

  beforeAll(async () => {
    ({ db, pool } = await freshDatabase());
    gmail = await startFakeSmtp(new Set(["revokedrevoked00"]));
  }, 120_000);
  afterAll(async () => {
    await gmail?.close();
    await pool?.end();
  });

  it("sends through the installation server with the business name and reply address when no Gmail is connected", async () => {
    const u = await owner();
    await saveProfile(db, u, { businessName: "Cruz Bakery", website: null, inquiryEmail: null, replyTo: "orders@cruz.example" });
    const out = await sendAs(db, key, deps(), u, mail, "k1");
    expect(out.from).toBe("daloy@localhost");
    const sent = JSON.parse(installation.at(-1)!) as { from: { name: string; address: string }; replyTo: { address: string }[] };
    expect(sent.from).toEqual({ name: "Cruz Bakery", address: "daloy@localhost" });
    expect(sent.replyTo[0]!.address).toBe("orders@cruz.example");
  });

  it("logs in to Gmail as the owner and sends from their address", async () => {
    const u = await owner();
    await connect(u, "lim.dental@gmail.com", "aaaa bbbb cccc dddd");
    const before = installation.length;
    const out = await sendAs(db, key, deps(), u, mail, "k2");
    expect(out.from).toBe("lim.dental@gmail.com");
    expect(gmail.messages.at(-1)).toMatchObject({ user: "lim.dental@gmail.com", from: "lim.dental@gmail.com", to: ["customer@example.com"] });
    expect(gmail.logins.at(-1)).toEqual({ user: "lim.dental@gmail.com", ok: true });
    expect(installation).toHaveLength(before);
  });

  it("refuses to send for a blocked sender without touching any server", async () => {
    const u = await owner();
    await connectGmail(db, key, u, { address: "unconfirmed@gmail.com", appPassword: "aaaa bbbb cccc dddd" });
    const before = [installation.length, gmail.messages.length, gmail.logins.length];
    await expect(sendAs(db, key, deps(), u, mail, "k3")).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("not confirmed") });
    expect([installation.length, gmail.messages.length, gmail.logins.length]).toEqual(before);
  });

  it("marks the sender failed when Google rejects the app password, and does not retry", async () => {
    const u = await owner();
    await connect(u, "revoked@gmail.com", "revokedrevoked00");
    await expect(sendAs(db, key, deps(), u, mail, "k4")).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("Reconnect Gmail") });
    expect(await readSender(db, u)).toMatchObject({ status: "failed" });
    await expect(sendAs(db, key, deps(), u, mail, "k5")).rejects.toMatchObject({ retryable: false });
    expect(gmail.logins.filter((l) => l.user === "revoked@gmail.com")).toHaveLength(1);
  });

  it("can skip the block for the verification email itself", async () => {
    const u = await owner();
    await connectGmail(db, key, u, { address: "new.owner@gmail.com", appPassword: "eeee ffff gggg hhhh" });
    await sendAs(db, key, deps(), u, { ...mail, to: "new.owner@gmail.com" }, "k6", { allowUnconfirmed: true });
    expect(gmail.messages.at(-1)).toMatchObject({ user: "new.owner@gmail.com", to: ["new.owner@gmail.com"] });
  });
});
