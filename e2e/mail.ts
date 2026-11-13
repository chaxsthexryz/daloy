import { readFileSync } from "node:fs";

// Quoted-printable, as nodemailer sends long lines: drop soft line breaks and decode =XX.
const decodeQp = (s: string) => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** Waits for an email to `to` in the SMTP sink and returns the approval link in it. */
export async function approvalLink(to: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const messages = readFileSync(process.env.E2E_MAIL_FILE!, "utf8").split("\n").filter(Boolean).map((l) => decodeQp(JSON.parse(l) as string));
    const link = messages.filter((m) => m.includes(to)).map((m) => /http:\/\/localhost:\d+\/approvals\/[A-Za-z0-9_-]{43}/.exec(m)?.[0]).find(Boolean);
    if (link) return link;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no approval email to ${to}`);
}
