import { lookup } from "node:dns/promises";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { simpleParser } from "mailparser";
import type { EmailPayload, ImapAdapter, ImapMessage } from "./email-in";
import { blockListOf, isBlocked, type SsrfGuard } from "./steps/ssrf";

export const MAX_EMAIL_BYTES = 256 * 1024;
const MAX_TEXT_LENGTH = 20_000;
type Source = Parameters<ImapAdapter>[0];
const defaultImapGuard = (): SsrfGuard => ({
  blockList: blockListOf(),
  resolve: (host) => lookup(host, { all: true, order: "verbatim" }),
  ports: [],
});
const permanentError = (message: string) => Object.assign(new Error(message), { permanent: true });

/** The connected IP is already checked; SNI and certificate validation still use the owner's original hostname. */
export async function imapConnectionOptions(
  source: Source,
  env: NodeJS.ProcessEnv = process.env,
  guard: SsrfGuard = defaultImapGuard(),
): Promise<ImapFlowOptions> {
  const fixture = env.NODE_ENV === "test" && source.host === "imap.office.example" && env.DALOY_TEST_IMAP_ENDPOINT;
  let host: string;
  let port = 993;
  if (fixture) {
    const url = new URL(fixture);
    if (
      url.protocol !== "imap:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/"].includes(url.pathname)
    )
      throw permanentError("Invalid IMAP test fixture endpoint");
    host = "127.0.0.1";
    port = Number(url.port);
  } else {
    // No hostname is given back to the socket API, so a rebinding DNS answer cannot replace the checked address.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      guard.resolve(source.host),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Mailbox DNS timeout")), 8_000);
        timeout.unref();
      }),
    ]).finally(() => clearTimeout(timeout));
    if (!addresses.length || addresses.some((a) => isBlocked(a.address, guard.blockList)))
      throw permanentError("IMAP host must resolve only to public addresses");
    host = addresses[0]!.address;
  }
  return {
    host,
    port,
    secure: !fixture,
    servername: source.host,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth: { user: source.username, pass: source.password },
    logger: false,
    logRaw: false,
    disableAutoIdle: true,
    disableAutoEnable: true,
    disableCompression: true,
    disableBinary: true,
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 8_000,
    maxLiteralSize: MAX_EMAIL_BYTES + 1,
    maxLineLength: 32_768,
    maxResponseSize: MAX_EMAIL_BYTES + 32_768,
    maxResponseTokens: 10_000,
  };
}

/** MIME is decoded inside the byte bound. Attachments and HTML never enter the run payload. */
export async function parseIncomingEmail(raw: Buffer, receivedAt: Date): Promise<EmailPayload> {
  if (raw.length > MAX_EMAIL_BYTES) throw new Error("Message is too large");
  const mail = await simpleParser(raw, { maxHtmlLengthToParse: MAX_EMAIL_BYTES, skipImageLinks: true });
  const from = mail.from?.value[0]?.address ?? "";
  const replyTo = mail.replyTo?.value[0]?.address ?? from;
  const to = (Array.isArray(mail.to) ? mail.to.flatMap((a) => a.value) : (mail.to?.value ?? []))
    .map((a) => a.address ?? "")
    .filter(Boolean)
    .slice(0, 30);
  return {
    from: from.slice(0, 320),
    replyTo: replyTo.slice(0, 320),
    to,
    subject: (mail.subject ?? "").slice(0, 1000),
    text: (mail.text ?? "").slice(0, MAX_TEXT_LENGTH),
    messageId: mail.messageId?.slice(0, 1000) ?? null,
    receivedAt: receivedAt.toISOString(),
  };
}

export const connectImap: ImapAdapter = async (source, signal) => {
  signal?.throwIfAborted();
  let client: ImapFlow | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  const abort = () => {
    client?.close();
    rejectStop(new Error("Mailbox check stopped"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  const close = async () => {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    client?.close();
  };
  try {
    client = new ImapFlow(await Promise.race([imapConnectionOptions(source), stopped]));
    // Errors are handled by the awaited operations. Never emit raw server or authentication data into process logs.
    client.on("error", () => {});
    // Bounds the whole connection, including an endless trickle of valid responses. The database claim lives longer.
    deadline = setTimeout(() => client!.close(), 30_000);
    deadline.unref();
    await Promise.race([client.connect(), stopped]);
    const box = await client.mailboxOpen(source.folder, { readOnly: true }).catch((err: unknown) => {
      if (err && typeof err === "object" && "responseStatus" in err && err.responseStatus === "NO")
        throw permanentError("Mailbox folder was refused");
      throw err;
    });
    return {
      uidValidity: String(box.uidValidity),
      uidNext: box.uidNext,
      async readBatch(afterUid) {
        // Scan a fixed UID window rather than SEARCHing an unbounded mailbox or fetching an unbounded sequence range.
        const throughUid = Math.min(afterUid + 20, box.uidNext - 1);
        if (throughUid <= afterUid) return { messages: [], throughUid: afterUid };
        const metas = await client!.fetchAll(`${afterUid + 1}:${throughUid}`, { uid: true, size: true }, { uid: true });
        if (metas.length > 20 || metas.some((m) => m.uid <= afterUid || m.uid > throughUid)) throw new Error("Invalid mailbox response");
        const messages: ImapMessage[] = [];
        for (const meta of metas.sort((a, b) => a.uid - b.uid)) {
          if ((meta.size ?? Infinity) > MAX_EMAIL_BYTES) {
            messages.push({ uid: meta.uid, payload: null, warning: "Skipped an email larger than 256 KB. Open the mailbox to read it." });
            continue;
          }
          const message = await client!.fetchOne(
            String(meta.uid),
            { uid: true, source: { start: 0, maxLength: MAX_EMAIL_BYTES + 1 }, internalDate: true },
            { uid: true },
          );
          if (!message) continue; // A person may delete a message between the two reads.
          if (!message.source) throw new Error("Mailbox omitted the requested message body");
          if (message.uid !== meta.uid) throw new Error("Wrong message UID");
          try {
            messages.push({
              uid: meta.uid,
              payload: await parseIncomingEmail(message.source, message.internalDate instanceof Date ? message.internalDate : new Date()),
            });
          } catch {
            messages.push({
              uid: meta.uid,
              payload: null,
              warning: "Skipped an email that could not be read safely. Open the mailbox to read it.",
            });
          }
        }
        return { messages, throughUid };
      },
      close,
    };
  } catch (err) {
    await close();
    if (err && typeof err === "object") {
      if (
        ("authenticationFailed" in err && err.authenticationFailed) ||
        ("code" in err && /^(?:CERT_|ERR_TLS_|DEPTH_ZERO_|SELF_SIGNED_)/.test(String(err.code)))
      )
        throw permanentError("Mailbox login or certificate was refused");
    }
    throw err;
  }
};
