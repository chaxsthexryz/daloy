import { Readable } from "node:stream";
import { StepError, type EmailConfig, type Outcome } from "@daloy/engine";
import { eq, sql } from "drizzle-orm";
import nodemailer, { type Transporter } from "nodemailer";
import * as z from "zod";
import type { Db } from "./index";
import { markSenderFailed, resolveSender, type ResolvedSender } from "./mail-senders";
import { sharedMailUsage, users } from "./schema";

export type Mailer = { transport: Transporter; from: string | { name: string; address: string }; replyTo?: string };
/**
 * The installation's own server, how to log in to Gmail as one owner, and who may use the shared server: "open" for
 * everyone (a local catcher such as Mailpit), "approved" for workspace owners the operator approved (decision 0024).
 */
export type MailDeps = { installation: Mailer; gmail: (auth: { user: string; pass: string }) => Transporter; sharedMail: "open" | "approved" };

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

const LOCAL_CATCHERS = new Set(["", "mailpit", "localhost", "127.0.0.1", "::1"]);

/**
 * SHARED_MAIL picks the policy. Unset, the shared server is open only when it is a local catcher, so pointing SMTP_HOST
 * at a real relay locks it to approved owners unless the operator says otherwise. Any other value means approved.
 * In production (NODE_ENV=production) unset always means approved: a localhost SMTP server there may be a relay.
 */
export function sharedMailPolicy(env: NodeJS.ProcessEnv = process.env): MailDeps["sharedMail"] {
  if (env.SHARED_MAIL) return env.SHARED_MAIL === "open" ? "open" : "approved";
  if (env.NODE_ENV === "production") return "approved";
  return LOCAL_CATCHERS.has(env.SMTP_HOST ?? "") ? "open" : "approved";
}

export const mailDeps = (env: NodeJS.ProcessEnv = process.env): MailDeps => ({ installation: smtpMailer(env), gmail: gmailTransport, sharedMail: sharedMailPolicy(env) });

/** The operator approves a workspace owner for the shared server, with a daily recipient limit. Null withdraws it. */
export async function approveSharedMail(db: Db, userId: string, dailyLimit: number | null) {
  await db.update(users).set({ sharedMailDailyLimit: dailyLimit }).where(eq(users.id, userId));
}

/** Whether this workspace may send through the shared server under the policy. Shown on Business and email. */
export async function sharedMailAllowed(db: Db, deps: MailDeps, userId: string) {
  if (deps.sharedMail === "open") return true;
  const [row] = await db.select({ limit: users.sharedMailDailyLimit }).from(users).where(eq(users.id, userId));
  return (row?.limit ?? 0) > 0;
}

/**
 * Counts n recipients against today's limit before anything is sent. One upsert under the row lock, so the limit holds
 * exactly across any number of API and worker processes. Throws, without retrying, when not approved or over the limit.
 */
async function claimSharedMail(db: Db, userId: string, n: number) {
  const [row] = await db.select({ limit: users.sharedMailDailyLimit }).from(users).where(eq(users.id, userId));
  const limit = row?.limit ?? 0;
  if (limit <= 0) {
    throw new StepError("This installation's mail server only sends for accounts its operator approved. Connect Gmail in Settings, Business and email to send from your own address.", false);
  }
  const day = sql`(now() at time zone 'utc')::date::text`;
  const claimed =
    n <= limit &&
    (
      await db
        .insert(sharedMailUsage)
        .values({ userId, day, sent: n })
        .onConflictDoUpdate({ target: [sharedMailUsage.userId, sharedMailUsage.day], set: { sent: sql`${sharedMailUsage.sent} + ${n}` }, setWhere: sql`${sharedMailUsage.sent} + ${n} <= ${limit}` })
        .returning({ sent: sharedMailUsage.sent })
    ).length > 0;
  if (!claimed) {
    throw new StepError(`This account reached today's limit of ${limit} recipients through this installation's mail server. Connect Gmail in Settings, Business and email, or try again tomorrow (UTC).`, false);
  }
}

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
  // The shared server is the one an unapproved sign-up could abuse; Gmail sends as the owner's own confirmed mailbox.
  if (sender.kind === "installation" && deps.sharedMail === "approved") await claimSharedMail(db, userId, checkRecipients(cfg.to).length);
  try {
    return { ...(await sendEmail(mailer, cfg, idempotencyKey)), from: addressOf(mailer.from), gmail: sender.kind === "gmail" };
  } catch (err) {
    if (sender.kind !== "gmail" || !loginRefused(err)) throw err;
    await markSenderFailed(db, userId, "Gmail rejected the app password.");
    throw new StepError("Gmail rejected the app password. Reconnect Gmail in Settings, Business and email.", false, { cause: err });
  }
}

/** Splits a resolved comma-separated "to" and checks each address and the cap. Also used for Outlook deliveries. */
export function checkRecipients(list: string): string[] {
  const to = list
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (to.length === 0) throw new StepError("email has no recipients", false);
  if (to.length > MAX_RECIPIENTS) throw new StepError(`email has ${to.length} recipients, the limit is ${MAX_RECIPIENTS}`, false);
  const bad = to.find((a) => !address.safeParse(a).success);
  if (bad !== undefined) throw new StepError(`"${bad.slice(0, 100)}" is not a valid email address`, false);
  return to;
}

type SendState = { bodyStarted: boolean };
const watched = new WeakSet<object>();

/**
 * nodemailer 10.5 pipes the message into the socket only once the server answered DATA with 354
 * (SMTPConnection.send), and its errors do not say how far the session got. This wraps the message stream so its
 * first read marks the moment part of the message may reach the server (decision 0030). Registered once per transport.
 */
function watchBody(transport: Mailer["transport"]) {
  if (watched.has(transport) || typeof transport.use !== "function") return;
  watched.add(transport);
  transport.use("stream", (mail, done) => {
    const state = (mail.data as { daloySend?: SendState }).daloySend;
    const message = mail.message as unknown as { createReadStream: (...args: unknown[]) => Readable };
    if (state) {
      const create = message.createReadStream.bind(message);
      const mark = () => (state.bodyStarted = true);
      message.createReadStream = (...args) => {
        const source = create(...args);
        async function* body() {
          mark();
          yield* source;
        }
        return Readable.from(body(), { objectMode: false });
      };
    }
    done();
  });
}

/** What an SMTP failure may have done. Without a server reply after the body started, the message may have arrived. */
function emailOutcome(code: number | undefined, bodyStarted: boolean): Outcome {
  if (code && code >= 500) return "rejected";
  if (code && code >= 400) return "throttled";
  return bodyStarted ? "unknown" : "not_sent";
}

/** Sends one plain-text email. Recipients come from a resolved template, so they are checked here, after resolution. */
export async function sendEmail(mailer: Mailer, cfg: EmailConfig, messageKey: string) {
  const to = checkRecipients(cfg.to);

  // messageKey is per attempt (run:step:attempt), so each attempt has its own Message-ID, and a re-delivered
  // attempt keeps it, so receivers can drop the duplicate.
  const messageId = `<${messageKey.replaceAll(":", ".")}@daloy>`;
  const daloySend: SendState = { bodyStarted: false };
  watchBody(mailer.transport);
  try {
    const info = await mailer.transport.sendMail({ from: mailer.from, replyTo: mailer.replyTo, to, subject: cfg.subject, text: cfg.text, messageId, daloySend } as Parameters<Mailer["transport"]["sendMail"]>[0]);
    // jsonTransport puts the built message in info.message; SMTP leaves it undefined.
    return { messageId, to, raw: typeof info.message === "string" ? info.message : undefined };
  } catch (err) {
    const outcome = emailOutcome((err as { responseCode?: number }).responseCode, daloySend.bodyStarted);
    // 5xx is a permanent refusal and unknown must not be resent blindly; 4xx and failures before the body may pass later.
    throw new StepError(`email failed: ${err instanceof Error ? err.message : String(err)}`, outcome === "not_sent" || outcome === "throttled", { cause: err, outcome });
  }
}
