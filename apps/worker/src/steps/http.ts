import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { StepError, type HttpConfig } from "@daloy/engine";
import { checkUrl, guardedLookup, type SsrfGuard } from "./ssrf";

export type HttpOptions = { guard: SsrfGuard; timeoutMs?: number; maxBytes?: number };
export type HttpOutput = { status: number; headers: IncomingHttpHeaders; body: unknown };

const MAX_REDIRECTS = 3;

function send(url: URL, method: string, headers: Record<string, string>, body: string | undefined, guard: SsrfGuard, signal: AbortSignal) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    // agent: false, so no pooled socket skips the guarded lookup.
    const req = (url.protocol === "https:" ? https : http).request(url, { method, headers, signal, agent: false, lookup: guardedLookup(guard) }, resolve);
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
      throw new StepError(`response is larger than ${maxBytes} bytes`, false);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One HTTP call with SSRF checks on every hop, a total timeout and a response size cap. */
export async function httpRequest(cfg: HttpConfig, idempotencyKey: string, opts: HttpOptions): Promise<HttpOutput> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const maxBytes = opts.maxBytes ?? 1_000_000;
  let url = checkUrl(cfg.url, opts.guard);
  let { method, body, headers } = cfg;

  try {
    for (let hop = 0; ; hop++) {
      const res = await send(url, method, { ...headers, "Idempotency-Key": idempotencyKey }, body, opts.guard, signal);
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hop === MAX_REDIRECTS) throw new StepError(`more than ${MAX_REDIRECTS} redirects`, false);
        const next = checkUrl(new URL(res.headers.location, url), opts.guard);
        if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        if (next.origin !== url.origin) {
          // A 307 or 308 keeps the body, which may hold private data: never resend it to someone else's server.
          if (body !== undefined) throw new StepError(`refusing to resend the request body to ${next.origin} after a ${status} redirect`, false);
          // Like fetch: credentials in the caller's headers must not follow a redirect to someone else's server.
          headers = {};
        }
        url = next;
        continue;
      }

      const text = await readBody(res, maxBytes);
      if (status >= 500 || status === 429) throw new StepError(`HTTP ${status} from ${url.host}`, true);
      if (status >= 400) throw new StepError(`HTTP ${status} from ${url.host}`, false);

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
    if (signal.aborted) throw new StepError(`request timed out after ${opts.timeoutMs ?? 10_000} ms`, true, { cause: err });
    if (err instanceof StepError) throw err;
    // DNS failures, refused or reset connections: worth another attempt.
    throw new StepError(`request failed: ${err instanceof Error ? err.message : String(err)}`, true, { cause: err });
  }
}
