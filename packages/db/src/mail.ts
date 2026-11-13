import { StepError, type EmailConfig } from "@daloy/engine";
import nodemailer, { type Transporter } from "nodemailer";
import * as z from "zod";
import type { Db } from "./index";
import { markSenderFailed, resolveSender, type ResolvedSender } from "./mail-senders";

export type Mailer = { transport: Transporter; from: string | { name: string; address: string }; replyTo?: string };
/** The installation's own server, and how to log in to Gmail as one owner. Tests replace both. */
export type MailDeps = { installation: Mailer; gmail: (auth: { user: string; pass: string }) => Transporter };

const MAX_RECIPIENTS = 10;
const address = z.email();

/** SMTP settings from env vars. Locally this is Mailpit on port 1025. */
export function smtpMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  const port = Number(env.SMTP_PORT ?? 1025);
  const auth = env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } : undefined;
  return {
    transport: nodemailer.createTransport({ host: env.SMTP_HOST ?? "localhost", port, secure: port === 465, auth }),
    from: env.SMTP_FROM ?? "Daloy <daloy@localhost>",
  };
}

/** Gmail's SMTP server with the owner's app password. A new connection per send, so no login outlives its message. */
export const gmailTransport = (auth: { user: string; pass: string }) => nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth });

export const mailDeps = (env: NodeJS.ProcessEnv = process.env): MailDeps => ({ installation: smtpMailer(env), gmail: gmailTransport });

const addressOf = (from: Mailer["from"]) => (typeof from === "string" ? (/<([^>]+)>/.exec(from)?.[1] ?? from) : from.address);

/** What to send with for a resolved sender. A blocked sender stops the send here, before any server is contacted. */
export function mailerFor(sender: ResolvedSender, deps: MailDeps): Mailer {
  if (sender.kind === "blocked") throw new StepError(sender.reason, false);
  // An object, so nodemailer quotes the business name and a comma or angle bracket in it cannot add a recipient.
  if (sender.kind === "installation") {
    const from = sender.fromName ? { name: sender.fromName, address: addressOf(deps.installation.from) } : deps.installation.from;
    return { ...deps.installation, from, replyTo: sender.replyTo };
  }
  return {
    transport: deps.gmail({ user: sender.address, pass: sender.password }),
    from: sender.fromName ? { name: sender.fromName, address: sender.address } : sender.address,
    replyTo: sender.replyTo,
  };
}

// nodemailer reports a refused login as EAUTH; Gmail answers a wrong or revoked app password with 535.
const loginRefused = (err: unknown) => {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    const { code, responseCode } = e as { code?: string; responseCode?: number };
    if (code === "EAUTH" || responseCode === 535) return true;
  }
  return false;
};

/**
 * Sends one email as the workflow owner: their Gmail, or the installation server when they connected none.
 * Every email and approval step goes through here, and so does the API's test email (decision 0020).
 */
export async function sendAs(db: Db, key: Buffer, deps: MailDeps, userId: string, cfg: EmailConfig, idempotencyKey: string, opts: { allowUnconfirmed?: boolean } = {}) {
  const sender = await resolveSender(db, key, userId, opts);
  const mailer = mailerFor(sender, deps);
  try {
    return { ...(await sendEmail(mailer, cfg, idempotencyKey)), from: addressOf(mailer.from), gmail: sender.kind === "gmail" };
  } catch (err) {
    if (sender.kind !== "gmail" || !loginRefused(err)) throw err;
    await markSenderFailed(db, userId, "Gmail rejected the app password.");
    throw new StepError("Gmail rejected the app password. Reconnect Gmail in Settings, Business and email.", false, { cause: err });
  }
}

/** Sends one plain-text email. Recipients come from a resolved template, so they are checked here, after resolution. */
export async function sendEmail(mailer: Mailer, cfg: EmailConfig, idempotencyKey: string) {
  const to = cfg.to
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (to.length === 0) throw new StepError("email has no recipients", false);
  if (to.length > MAX_RECIPIENTS) throw new StepError(`email has ${to.length} recipients, the limit is ${MAX_RECIPIENTS}`, false);
  const bad = to.find((a) => !address.safeParse(a).success);
  if (bad !== undefined) throw new StepError(`"${bad.slice(0, 100)}" is not a valid email address`, false);

  // A retried attempt gets a new key, but a re-delivered one keeps it, so receivers can drop the duplicate.
  const messageId = `<${idempotencyKey.replaceAll(":", ".")}@daloy>`;
  try {
    const info = await mailer.transport.sendMail({ from: mailer.from, replyTo: mailer.replyTo, to, subject: cfg.subject, text: cfg.text, messageId });
    // jsonTransport puts the built message in info.message; SMTP leaves it undefined.
    return { messageId, to, raw: typeof info.message === "string" ? info.message : undefined };
  } catch (err) {
    const code = (err as { responseCode?: number }).responseCode;
    // 5xx is a permanent SMTP rejection; 4xx and connection errors may pass on a later attempt.
    throw new StepError(`email failed: ${err instanceof Error ? err.message : String(err)}`, !(code && code >= 500), { cause: err });
  }
}
