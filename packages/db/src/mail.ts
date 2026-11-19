import { Readable } from "node:stream";
import { readBrand, type Brand } from "./brand";
import { claimUsage } from "./usage";
import { StepError, type EmailConfig, type Outcome } from "@daloy/engine";
import { eq, sql } from "drizzle-orm";
import nodemailer, { type Transporter } from "nodemailer";
import * as z from "zod";
import type { Db } from "./index";
import { markSenderFailed, resolveSender, type ResolvedSender } from "./mail-senders";
import { withFreshToken } from "./oauth/core";
import { gmail, gmailSend } from "./oauth/gmail";
import { ProviderError, providerUrls, type ProviderUrls } from "./providers";
import { sharedMailUsage, users } from "./schema";

export type Mailer = { host?: string; transport: Transporter; from: string | { name: string; address: string }; replyTo?: string };
/**
 * The installation's own server, how to log in to Gmail as one owner, and who may use the shared server: "open" for
 * everyone (a local catcher such as Mailpit), "approved" for workspace owners the operator approved (decision 0024).
 */
export type MailDeps = {
  installation: Mailer;
  gmail: (auth: { user: string; pass: string }) => Transporter;
  sharedMail: "open" | "approved";
  /** The Google client and the Gmail API, for a Google sign-in (decision 0063). Unset: such a sender is blocked, never replaced. */
  urls?: ProviderUrls;
};

const MAX_RECIPIENTS = 10;
const address = z.email();

/** SMTP settings from env vars. Locally this is Mailpit on port 1025. */
export function smtpMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  const port = Number(env.SMTP_PORT ?? 1025);
  const auth = env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } : undefined;
  const host = env.SMTP_HOST ?? "localhost";
  return {
    host,
    transport: nodemailer.createTransport({ host, port, secure: port === 465, auth }),
    from: env.SMTP_FROM ?? "Daloy <daloy@localhost>",
  };
}

/** Gmail's SMTP server with the owner's app password. A new connection per send, so no login outlives its message. */
export const gmailTransport = (auth: { user: string; pass: string }) => nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth });

const LOCAL_CATCHERS = new Set(["", "mailpit", "localhost", "127.0.0.1", "::1"]);
/** shortcut: judged by host name only, so a real server behind a local name reads as local; fine for a hint. */
export const isLocalCatcher = (host: string | undefined) => LOCAL_CATCHERS.has(host ?? "");

/**
 * SHARED_MAIL picks the policy. Unset, the shared server is open only when it is a local catcher, so pointing SMTP_HOST
 * at a real relay locks it to approved owners unless the operator says otherwise. Any other value means approved.
 * In production (NODE_ENV=production) unset always means approved: a localhost SMTP server there may be a relay.
 */
export function sharedMailPolicy(env: NodeJS.ProcessEnv = process.env): MailDeps["sharedMail"] {
  if (env.SHARED_MAIL) return env.SHARED_MAIL === "open" ? "open" : "approved";
  if (env.NODE_ENV === "production") return "approved";
  return isLocalCatcher(env.SMTP_HOST) ? "open" : "approved";
}

export const mailDeps = (env: NodeJS.ProcessEnv = process.env): MailDeps => ({ installation: smtpMailer(env), gmail: gmailTransport, sharedMail: sharedMailPolicy(env), urls: providerUrls(env) });

/** The operator approves a workspace owner for the shared server, with a daily recipient limit. Null withdraws it. */
export async function approveSharedMail(db: Db, userId: string, dailyLimit: number | null) {
  await db.update(users).set({ sharedMailDailyLimit: dailyLimit }).where(eq(users.id, userId));
}

/** Whether this workspace may send through the shared server under the policy. Shown on Apps. */
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
    throw new StepError("This installation's mail server only sends for accounts its operator approved. Connect Gmail in Apps to send from your own address.", false);
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
    throw new StepError(`This account reached today's limit of ${limit} recipients through this installation's mail server. Connect Gmail in Apps, or try again tomorrow (UTC).`, false);
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
    // The Gmail API takes the message nodemailer builds for SMTP, so it is built by a stream transport (rawMessage).
    transport: sender.kind === "gmail" ? deps.gmail({ user: sender.address, pass: sender.password }) : rawBuilder,
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
/**
 * claim, for a send that is not safe to repeat, is called once the sender is known and nothing but the network is left,
 * so its database lock never waits on another query; it is released when the message body starts (decision 0030).
 */
export async function sendAs(db: Db, key: Buffer, deps: MailDeps, userId: string, cfg: EmailConfig, idempotencyKey: string, opts: { allowUnconfirmed?: boolean; claim?: () => Promise<() => void>; capKey?: string } = {}) {
  const sender = await resolveSender(db, key, userId, opts);
  const mailer = mailerFor(sender, deps);
  // Before the claim below: the send lock must never wait on a query (decision 0030).
  const brand = await readBrand(db, userId);
  // The shared server is the one an unapproved sign-up could abuse; Gmail sends as the owner's own confirmed mailbox.
  if (sender.kind === "installation" && deps.sharedMail === "approved") await claimSharedMail(db, userId, checkRecipients(cfg.to).length);
  // Gmail has its own daily limit, so a workspace is capped before a busy automation gets the owner's mailbox suspended (N11b).
  // capKey is the step key, the same on every attempt, so a retry is not counted twice. The watchdog and the test email pass none: they are not counted.
  // A Google sign-in sends from the same mailbox, so it counts the same.
  if ((sender.kind === "gmail" || sender.kind === "gmail_api") && opts.capKey) await claimUsage(db, userId, "mailbox", { n: checkRecipients(cfg.to).length, key: opts.capKey });
  if (sender.kind === "gmail_api") return { ...(await sendWithGmailApi(db, key, deps, userId, sender, mailer, cfg, idempotencyKey, brand, opts.claim)), from: addressOf(mailer.from), gmail: true };
  try {
    const release = await opts.claim?.();
    try {
      return { ...(await sendEmail(mailer, cfg, idempotencyKey, release, brand)), from: addressOf(mailer.from), gmail: sender.kind === "gmail" };
    } finally {
      // Before the catch below writes to the database (Astra, 6170f4f: ten held locks waiting on lookups emptied the pool).
      release?.();
    }
  } catch (err) {
    if (sender.kind !== "gmail" || !loginRefused(err)) throw err;
    await markSenderFailed(db, userId, "Gmail rejected the app password.");
    throw new StepError("Gmail rejected the app password. Reconnect Gmail in Apps.", false, { cause: err });
  }
}

/**
 * One email through the Gmail API with a Google sign-in (decision 0063). The token is refreshed before the send claim,
 * so the claim's lock never waits on a query (decision 0030), and released as the request goes out. A 401 refreshes
 * once and sends again (Gmail did not take the first). A refused grant marks the sender failed: nothing falls back to
 * another sender (decision 0020). A 5xx or a timeout after the request left is unknown and never resent on its own.
 */
async function sendWithGmailApi(db: Db, key: Buffer, deps: MailDeps, userId: string, sender: Extract<ResolvedSender, { kind: "gmail_api" }>, mailer: Mailer, cfg: EmailConfig, messageKey: string, brand: Brand | null, claim?: () => Promise<() => void>) {
  const { to, messageId, raw } = await rawMessage(mailer, cfg, messageKey, brand);
  const urls = deps.urls;
  if (!urls || !gmail.client(urls) || !urls.gmail) throw new StepError("Gmail sign-in is not set up on this installation any more. Connect Gmail again in Apps.", false, { outcome: "not_sent" });
  try {
    await withFreshToken(db, key, urls, userId, gmail, sender.grant, async (token) => {
      (await claim?.())?.();
      return gmailSend(urls, token, raw);
    });
    return { messageId, to, raw: undefined };
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.kind === "auth") {
      // A refused refresh marked the sender already; a second 401 after a fresh token marks it here.
      await markSenderFailed(db, userId, "Gmail no longer accepts Daloy's access. Reconnect Gmail in Apps.");
      throw new StepError("Gmail no longer accepts Daloy's access, so nothing was sent. Reconnect Gmail in Apps.", false, { cause: err, outcome: "not_sent" });
    }
    if (err.kind === "quota") throw new StepError(`email failed: ${err.message}`, true, { cause: err, outcome: "throttled", retryAfterMs: err.retryAfterMs });
    if (err.kind === "unavailable") throw new StepError(`email failed: ${err.message}`, true, { cause: err, outcome: "not_sent" });
    if (err.kind === "ambiguous") throw new StepError(`email failed: ${err.message}`, false, { cause: err, outcome: "unknown" });
    throw new StepError(`email failed: ${err.message}`, false, { cause: err, outcome: "rejected" });
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

type SendState = { bodyStarted: boolean; onBodyStart?: () => void };
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
      const mark = () => {
        state.bodyStarted = true;
        state.onBodyStart?.();
      };
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

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The owner's brand as an HTML part: a header band in the accent colour (text colour chosen for contrast) with the logo
 * attached inline by cid, so no mail client fetches anything from a website. The text part stays and gets a name line.
 */
function brandedParts(cfg: EmailConfig, brand: Brand) {
  const name = brand.name ?? "";
  const band = `background:${brand.accent ?? "#f3f4f6"};color:${brand.ink ?? "#111111"}`;
  const logo = brand.logo ? `<img src="cid:brand-logo" alt="${esc(name)}" height="40" style="vertical-align:middle;margin-right:10px">` : "";
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px"><div style="${band};padding:12px 16px;font-size:18px">${logo}${esc(name)}</div><div style="padding:16px 4px;white-space:pre-wrap">${esc(cfg.text)}</div></div>`;
  const attachments = brand.logo ? [{ filename: `logo.${brand.logo.type}`, content: brand.logo.data, cid: "brand-logo", contentType: `image/${brand.logo.type}` }] : [];
  return { text: name ? `${cfg.text}\n\n-- ${name}` : cfg.text, html, attachments };
}

/**
 * What nodemailer is given for one email, plain text unless a brand is given. Recipients come from a resolved template,
 * so they are checked here, after resolution. SMTP and the Gmail API both send this, so their headers are the same.
 */
function message(mailer: Mailer, cfg: EmailConfig, messageKey: string, brand?: Brand | null) {
  const to = checkRecipients(cfg.to);
  // messageKey is per attempt (run:step:attempt), so each attempt has its own Message-ID, and a re-delivered
  // attempt keeps it, so receivers can drop the duplicate.
  const messageId = `<${messageKey.replaceAll(":", ".")}@daloy>`;
  return { to, messageId, mail: { from: mailer.from, replyTo: mailer.replyTo, to, subject: cfg.subject, ...(brand ? brandedParts(cfg, brand) : { text: cfg.text }), messageId } };
}

/** Builds a message without sending it. */
const rawBuilder = nodemailer.createTransport({ streamTransport: true, buffer: true });

/** The RFC 822 bytes of an email, as SMTP would send them, for the Gmail API (decision 0063). */
export async function rawMessage(mailer: Mailer, cfg: EmailConfig, messageKey: string, brand?: Brand | null) {
  const { to, messageId, mail } = message(mailer, cfg, messageKey, brand);
  const info = await rawBuilder.sendMail(mail);
  return { to, messageId, raw: info.message as Buffer };
}

/** Sends one email, plain text unless a brand is given. */
export async function sendEmail(mailer: Mailer, cfg: EmailConfig, messageKey: string, onBodyStart?: () => void, brand?: Brand | null) {
  const { to, messageId, mail } = message(mailer, cfg, messageKey, brand);
  const daloySend: SendState = { bodyStarted: false, onBodyStart };
  watchBody(mailer.transport);
  try {
    const info = await mailer.transport.sendMail({ ...mail, daloySend } as unknown as Parameters<Mailer["transport"]["sendMail"]>[0]);
    // jsonTransport puts the built message in info.message; SMTP leaves it undefined.
    return { messageId, to, raw: typeof info.message === "string" ? info.message : undefined };
  } catch (err) {
    const outcome = emailOutcome((err as { responseCode?: number }).responseCode, daloySend.bodyStarted);
    // 5xx is a permanent refusal and unknown must not be resent blindly; 4xx and failures before the body may pass later.
    throw new StepError(`email failed: ${err instanceof Error ? err.message : String(err)}`, outcome === "not_sent" || outcome === "throttled", { cause: err, outcome });
  }
}
