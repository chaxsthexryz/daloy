import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { isIdempotent, StepError, type HttpConfig, type Outcome } from "@daloy/engine";
import { checkUrl, guardedLookup, type SsrfGuard } from "./ssrf";

/**
 * claim: called right before every request, redirects included; resolves to a release function once this worker may
 * send, rejects when it may not (another worker took the attempt over, or it was stopped). Released once the request
 * is handed to the socket (decision 0030).
 */
export type HttpOptions = { guard: SsrfGuard; timeoutMs?: number; maxBytes?: number; claim?: () => Promise<() => void> };
export type HttpOutput = { status: number; headers: IncomingHttpHeaders; body: unknown };

const MAX_REDIRECTS = 3;

/**
 * onOpen fires once the socket can carry request bytes: TCP connect for http, the finished TLS handshake for https
 * (Node sends no application data before it). Until then nothing can have reached the receiver. A request's
 * "finish" event is no proof either way: it only means the bytes left Node, so it is not used (decision 0030).
 */
function send(url: URL, method: string, headers: Record<string, string>, body: string | undefined, guard: SsrfGuard, signal: AbortSignal, onOpen: () => void, onWritten: () => void) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    // agent: false, so no pooled socket skips the guarded lookup, and every request opens its own socket.
    const req = (url.protocol === "https:" ? https : http).request(url, { method, headers, signal, agent: false, lookup: guardedLookup(guard) }, resolve);
    req.once("socket", (socket) => socket.once(url.protocol === "https:" ? "secureConnect" : "connect", onOpen));
    req.once("finish", onWritten);
    req.on("error", reject);
    req.end(body);
  });
}

async function readBody(res: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) {
      res.destroy();
      // The receiver answered, so it has the request: never send it again.
      throw new StepError(`response is larger than ${maxBytes} bytes`, false, { outcome: "rejected" });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Retry-After as delta seconds or an HTTP date, in ms from now. Undefined when absent or unreadable. */
function retryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * One HTTP call with SSRF checks on every hop, a total timeout and a response size cap. Every failure carries an
 * outcome (decision 0030): not_sent and throttled are retried, rejected never is, unknown only on an idempotent step.
 * The Idempotency-Key is the same on every attempt; it is a hint, never relied on.
 */
export async function httpRequest(cfg: HttpConfig, idempotencyKey: string, opts: HttpOptions): Promise<HttpOutput> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const idempotent = isIdempotent(cfg);
  const fail = (message: string, outcome: Outcome, extra: { cause?: unknown; retryAfterMs?: number } = {}) =>
    answered && !idempotent
      ? new StepError(message, false, { outcome: "unknown", cause: extra.cause })
      : new StepError(message, outcome === "not_sent" || outcome === "throttled" || (outcome === "unknown" && idempotent), { outcome, ...extra });
  // Sticky across redirects: once any hop could carry bytes, the first request may have been acted on.
  let opened = false;
  // The receiver answered the first request with a redirect, so it has it. A step that is not idempotent must then
  // never be sent again on its own, whatever happens on the way to the redirect target (Astra, b31c4ce).
  let answered = false;
  let release = () => {};
  let url = checkUrl(cfg.url, opts.guard);
  let { method, body, headers } = cfg;

  try {
    for (let hop = 0; ; hop++) {
      // Every hop: a redirect answered late must not start a new request after the run was taken over or stopped (Astra, 6170f4f).
      if (opts.claim) {
        const done = await opts.claim();
        let released = false;
        release = () => {
          if (released) return;
          released = true;
          done();
        };
      }
      const res = await send(url, method, { ...headers, "Idempotency-Key": idempotencyKey }, body, opts.guard, signal, () => (opened = true), () => release());
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        answered = true;
        if (hop === MAX_REDIRECTS) throw fail(`more than ${MAX_REDIRECTS} redirects`, "rejected");
        const next = checkUrl(new URL(res.headers.location, url), opts.guard);
        if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        if (next.origin !== url.origin) {
          // A 307 or 308 keeps the body, which may hold private data: never resend it to someone else's server.
          if (body !== undefined) throw fail(`refusing to resend the request body to ${next.origin} after a ${status} redirect`, "rejected");
          // Like fetch: credentials in the caller's headers must not follow a redirect to someone else's server.
          headers = {};
        }
        url = next;
        continue;
      }

      // The status decides a failure, so its body is never read: a large error page cannot change the outcome.
      if (status >= 400) {
        res.destroy();
        if (status === 429) throw fail(`HTTP 429 from ${url.host}`, "throttled", { retryAfterMs: retryAfterMs(res.headers["retry-after"]) });
        if (status >= 500 || status === 408) throw fail(`HTTP ${status} from ${url.host}`, "unknown");
        throw fail(`HTTP ${status} from ${url.host}`, "rejected");
      }
      const text = await readBody(res, maxBytes);

      let parsed: unknown = text;
      if (/\bjson\b/i.test(res.headers["content-type"] ?? "")) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // Keep the raw text when the server lies about the content type.
        }
      }
      return { status, headers: res.headers, body: parsed };
    }
  } catch (err) {
    if (err instanceof StepError && err.outcome) throw answered && !idempotent ? fail(err.message, err.outcome, { cause: err }) : err;
    // An SSRF refusal or a failed lookup happens before any socket opens on this hop.
    if (err instanceof StepError) throw answered && !idempotent ? fail(err.message, "not_sent", { cause: err }) : new StepError(err.message, err.retryable, { cause: err, outcome: "not_sent" });
    const message = signal.aborted ? `request timed out after ${opts.timeoutMs ?? 10_000} ms` : `request failed: ${err instanceof Error ? err.message : String(err)}`;
    // Refused, unreachable or timed out before the socket opened: provably not sent. Anything later may have arrived.
    throw fail(message, opened ? "unknown" : "not_sent", { cause: err });
  } finally {
    release();
  }
}
