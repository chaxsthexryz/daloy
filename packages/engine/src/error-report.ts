/**
 * Minimal zero-dependency Sentry / GlitchTip envelope client (A2, decision 0124).
 * Runs identically in Node (api, worker) and browsers (web) using Fetch + Web Crypto.
 * Unset or malformed DSNs turn reporting into a quiet no-op, and network errors never propagate.
 */

export type ParsedDsn = {
  storeUrl: string;
  authHeader: string;
  origin: string;
};

export type ErrorReporterOptions = {
  dsn?: string;
  service: "api" | "worker" | "web";
  environment?: string;
  platform?: "node" | "javascript";
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxPerMinute?: number;
};

export type ErrorContext = {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

export type ErrorReporter = {
  enabled: boolean;
  origin: string | null;
  capture: (err: unknown, context?: ErrorContext) => Promise<boolean>;
};

const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|password|token|secret|api[-_]?key|credential|key|secrets[-_]?key|signature)$/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;

export function parseSentryDsn(dsn: string | undefined): ParsedDsn | null {
  const raw = dsn?.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const publicKey = u.username.trim();
  if (!publicKey || u.password) return null;
  const segments = u.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!projectId || !/^[A-Za-z0-9_-]+$/.test(projectId)) return null;
  const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
  return {
    storeUrl: `${u.origin}${prefix}/api/${projectId}/store/`,
    authHeader: `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=daloy/1.0`,
    origin: u.origin,
  };
}

function scrubString(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    try {
      const parsed = new URL(match);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return match.split(/[?#]/, 1)[0] ?? match;
    }
  });
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value).slice(0, 1000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => scrubValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : scrubValue(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 200);
}

function eventId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replace(/-/g, "");
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, "0").slice(0, 32);
}

function toException(err: unknown): { type: string; value: string } {
  if (err instanceof Error) {
    return {
      type: err.name || "Error",
      value: scrubString(err.message || err.name || "Error").slice(0, 1000),
    };
  }
  return {
    type: "Error",
    value: scrubString(typeof err === "string" ? err : JSON.stringify(scrubValue(err)) ?? String(err)).slice(0, 1000),
  };
}

export function createErrorReporter(opts: ErrorReporterOptions): ErrorReporter {
  const parsed = parseSentryDsn(opts.dsn);
  if (!parsed) {
    return { enabled: false, origin: null, capture: async () => false };
  }
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return { enabled: false, origin: parsed.origin, capture: async () => false };
  }
  const maxPerMinute = opts.maxPerMinute ?? 20;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const platform = opts.platform ?? (opts.service === "web" ? "javascript" : "node");
  const environment = opts.environment?.trim() || undefined;
  const windowHits: number[] = [];

  return {
    enabled: true,
    origin: parsed.origin,
    async capture(err: unknown, context?: ErrorContext): Promise<boolean> {
      const now = Date.now();
      while (windowHits.length > 0 && now - windowHits[0]! >= 60_000) windowHits.shift();
      if (windowHits.length >= maxPerMinute) return false;
      windowHits.push(now);

      const ex = toException(err);
      const body = JSON.stringify({
        event_id: eventId(),
        timestamp: Math.floor(now / 1000),
        level: "error",
        platform,
        ...(environment ? { environment } : {}),
        tags: { service: opts.service, ...(context?.tags ?? {}) },
        exception: { values: [ex] },
        ...(context?.extra ? { extra: scrubValue(context.extra) } : {}),
      });

      try {
        const res = await fetchFn(parsed.storeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sentry-auth": parsed.authHeader,
          },
          body,
          signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined,
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
