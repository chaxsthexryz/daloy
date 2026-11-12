import { StepError, type EmailConfig } from "@daloy/engine";
import nodemailer, { type Transporter } from "nodemailer";
import * as z from "zod";

export type Mailer = { transport: Transporter; from: string };

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
    const info = await mailer.transport.sendMail({ from: mailer.from, to, subject: cfg.subject, text: cfg.text, messageId });
    // jsonTransport puts the built message in info.message; SMTP leaves it undefined.
    return { messageId, to, raw: typeof info.message === "string" ? info.message : undefined };
  } catch (err) {
    const code = (err as { responseCode?: number }).responseCode;
    // 5xx is a permanent SMTP rejection; 4xx and connection errors may pass on a later attempt.
    throw new StepError(`email failed: ${err instanceof Error ? err.message : String(err)}`, !(code && code >= 500), { cause: err });
  }
}
