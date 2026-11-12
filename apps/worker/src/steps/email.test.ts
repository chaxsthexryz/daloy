import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";
import { sendEmail, type Mailer } from "./email";

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
