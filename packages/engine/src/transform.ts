import { normalizePhMobile } from "./phone";
import { resolveTemplate, type ExpressionContext } from "./expressions";
import { formatZoned, isTimeZone, parseInstant } from "./zoned";

export const TRANSFORM_OPS = [
  "format_date",
  "format_peso",
  "normalize_phone",
  "split",
  "trim",
  "lowercase",
  "uppercase",
  "pick",
] as const;

export type TransformOp = (typeof TRANSFORM_OPS)[number];
export type DateFormat = "readable" | "iso" | "date" | "time" | "datetime";

export type TransformInput = {
  op: TransformOp;
  value?: string;
  timezone?: string;
  format?: DateFormat;
  separator?: string;
  fields?: Record<string, string>;
};

export const TRANSFORM_SPLIT_MAX = 200;

export class TransformError extends Error {
  override name = "TransformError";
}

const asString = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const PESO_TEXT = /^([+-])?(?:(?:₱|PHP)\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/i;
const PESO_LEADING_DOT = /^([+-])?(?:(?:₱|PHP)\s*)?\.(\d+)$/i;

function parseDateValue(raw: unknown): Date {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new TransformError("Date value must be a valid date or timestamp.");
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new TransformError("Date value must be a valid date or timestamp.");
    return d;
  }
  const s = asString(raw).trim();
  if (!s) throw new TransformError("Date value is empty.");
  const instant = parseInstant(s);
  if (instant) return instant;
  const dateOnly = DATE_ONLY.exec(s);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
    const parsed = new Date(ms);
    if (parsed.getUTCFullYear() === Number(y) && parsed.getUTCMonth() === Number(m) - 1 && parsed.getUTCDate() === Number(d)) {
      return parsed;
    }
    throw new TransformError(`Invalid calendar date "${s}".`);
  }
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) throw new TransformError(`Could not read "${s.slice(0, 60)}" as a date.`);
  return new Date(parsed);
}

function parsePesoValue(raw: unknown): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new TransformError("Peso amount must be a finite number.");
    return raw;
  }
  const s = asString(raw).trim();
  if (!s) throw new TransformError("Peso amount is empty.");
  const normalized = s.replace(/\s+/g, " ");
  if (!PESO_TEXT.test(normalized) && !PESO_LEADING_DOT.test(normalized)) {
    throw new TransformError(`Could not read "${s.slice(0, 60)}" as a peso amount.`);
  }
  const clean = normalized.replace(/^(?:([+-])?\s*)?(?:₱|PHP)\s*/i, "$1").replaceAll(",", "");
  const n = Number(clean);
  if (!Number.isFinite(n)) throw new TransformError(`Could not read "${s.slice(0, 60)}" as a peso amount.`);
  return n;
}

const readableFormats = new Map<string, Intl.DateTimeFormat>();
function readableFormat(timeZone: string) {
  let fmt = readableFormats.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-PH", {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    readableFormats.set(timeZone, fmt);
  }
  return fmt;
}

const pesoNumberFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Deterministic, side-effect-free value formatting and picking (phase E4, decision 0131).
 * Never executes arbitrary code or dynamic expressions beyond safe {{...}} lookup.
 */
export function runTransform(config: TransformInput, ctx: ExpressionContext): Record<string, unknown> {
  if (config.op === "pick") {
    const out: Record<string, unknown> = {};
    for (const [k, tmpl] of Object.entries(config.fields ?? {})) {
      const val = resolveTemplate(tmpl, ctx);
      out[k] = val === undefined ? null : val;
    }
    return out;
  }

  const resolved = resolveTemplate(config.value ?? "", ctx);

  switch (config.op) {
    case "trim":
      return { result: asString(resolved).trim() };
    case "lowercase":
      return { result: asString(resolved).toLowerCase() };
    case "uppercase":
      return { result: asString(resolved).toUpperCase() };
    case "normalize_phone": {
      const r = normalizePhMobile(asString(resolved));
      if (!r.ok) throw new TransformError(r.error);
      return { result: r.value, local: `0${r.value.slice(3)}` };
    }
    case "format_peso": {
      const amount = Math.round(parsePesoValue(resolved) * 100) / 100;
      const sign = amount < 0 ? "-" : "";
      const abs = Math.abs(amount);
      const formatted = pesoNumberFormat.format(abs);
      return {
        result: `${sign}PHP ${formatted}`,
        plain: `${sign}${abs.toFixed(2)}`,
        code: `${sign}PHP ${formatted}`,
        amount,
      };
    }
    case "format_date": {
      const tz = config.timezone?.trim() || "Asia/Manila";
      if (!isTimeZone(tz)) throw new TransformError(`Unknown timezone "${tz}". Use an IANA name such as Asia/Manila.`);
      const date = parseDateValue(resolved);
      const iso = formatZoned(date, tz);
      const fmt = config.format ?? "readable";
      const result =
        fmt === "iso"
          ? iso
          : fmt === "date"
            ? iso.slice(0, 10)
            : fmt === "time"
              ? iso.slice(11, 16)
              : fmt === "datetime"
                ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
                : readableFormat(tz).format(date);
      return { result, iso, timezone: tz };
    }
    case "split": {
      const sep = config.separator ?? ",";
      if (!sep) throw new TransformError("Separator cannot be empty.");
      const raw = asString(resolved);
      const items =
        raw.trim() === ""
          ? []
          : raw
              .split(sep)
              .map((s) => s.trim())
              .filter((s) => (sep.trim() === "" ? s.length > 0 : true));
      if (items.length > TRANSFORM_SPLIT_MAX) {
        throw new TransformError(`Split produced ${items.length} items, above the ${TRANSFORM_SPLIT_MAX}-item limit.`);
      }
      return { result: items, items, first: items[0] ?? "", last: items.at(-1) ?? "", count: items.length };
    }
  }
}
