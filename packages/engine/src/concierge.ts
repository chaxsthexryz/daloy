import { buildPrompt, type AiConfig } from "./ai";
import { PRICED_KINDS, WEEKDAYS, type KnowledgeEntry, type KnowledgeFields } from "./knowledge";
import type { Language } from "./language";
import { normalizePhMobile } from "./phone";

/*
 * The resort concierge's safety core (C4, decision 0119). Everything here is plain code with no model in it: the model
 * writes a reply, and these functions decide what of it may reach a guest.
 */

// ---------- Guest contact details: never sent to the model (plan, "Minimise what reaches the model") ----------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// A phone starts with +, 0 or 63 and has 10 to 13 digits, so dates (2026-12-14, 12/26) and prices (3,500) are left alone.
const PHONE = /(?:\+|\b0|\b63)[\d\s().-]{8,18}\d/g;
const phoneDigits = (s: string) => s.replace(/\D/g, "").length;

export function redactContacts(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PHONE, (m) => (phoneDigits(m) >= 10 && phoneDigits(m) <= 13 ? "[phone]" : m));
}

/** The first email and Philippine mobile in a guest's message, found by pattern so the model never needs to read them. */
export function contactsIn(text: string): { email?: string; phone?: string } {
  const email = text.match(EMAIL)?.[0]?.toLowerCase();
  const phone = (text.match(PHONE) ?? []).map((m) => normalizePhMobile(m)).find((r) => r.ok);
  return { ...(email && { email }), ...(phone?.ok && { phone: phone.value }) };
}

// ---------- The answer prompt ----------

export type HistoryItem = { direction: string; text: string; at?: string };
const SPEAKER: Record<string, string> = { in: "Guest", out: "Resort", staff: "Staff" };

/**
 * The system prompt carries the owner's published knowledge (trusted text the owner wrote); the guest's messages stay
 * in the delimited user message, with emails and phone numbers replaced by [email] and [phone].
 */
export function answerPrompt(cfg: AiConfig, input: string, history: HistoryItem[], entries: KnowledgeEntry[]) {
  // The run's own message is already the last history item (C1 records it first), so it is not sent twice.
  const last = history.at(-1);
  const earlier = last?.direction === "in" && last.text.trim() === input.trim() ? history.slice(0, -1) : history;
  const lines = earlier.map((h) => `${SPEAKER[h.direction] ?? "Resort"}: ${redactContacts(h.text)}`);
  const data = [...(lines.length ? ["Earlier messages, oldest first:", ...lines, ""] : []), `Latest guest message: ${redactContacts(input)}`].join("\n");
  const prompt = buildPrompt(cfg, data);
  const sheet = entries.map(({ id, kind, title, body, fields }) => ({ id, kind, title, ...(body && { body }), ...(Object.keys(fields).length && { fields }) }));
  return { ...prompt, system: `${prompt.system}\n\nThe resort's knowledge sheet. These entries are the only facts you may use:\n${JSON.stringify(sheet)}` };
}

// ---------- guardReply ----------

const MESSAGES = {
  price: { en: "Our team will confirm the rate and reply here shortly.", tl: "Kukumpirmahin ng aming team ang presyo at sasagot dito sa lalong madaling panahon." },
  availability: { en: "I'll check with the team and get back to you here.", tl: "Itatanong ko muna sa team at babalikan kita dito." },
} satisfies Record<string, Record<Language, string>>;

// Saying a room is open or taken, in English and Tagalog. A false match only costs a "we will check" reply.
const AVAILABILITY = [
  /\b(?:un)?availab(?:le|ility)\b/i,
  /\bvacan(?:t|cy|cies)\b/i,
  /\b(?:fully|already)\s+booked\b/i,
  /\bbooked\s+(?:up|out|solid)\b/i,
  /\bsold\s+out\b/i,
  /\bno\s+(?:more\s+)?(?:rooms?|vacanc\w*|slots?|space)\b/i,
  /\b(?:rooms?|cottages?|villas?|units?|slots?|dates?|it)\s+(?:is|are)\s+(?:still\s+)?(?:free|open|taken|booked|reserved)\b/i,
  /\b(?:reserved|on\s+hold)\s+for\s+you\b/i,
  /\bfree\s+(?:rooms?|slots?|dates?)\b/i,
  /\bwe\s+(?:still\s+)?have\s+(?:rooms?|space|slots?|openings?)\b/i,
  /\bbakante\b/i,
  /\bmay\s+(?:slot|room|kwarto|kuwarto|space|bakante)\b/i,
  /\bmeron\s+(?:pa\s+)?(?:po\s+)?(?:kaming\s+)?(?:slot|room|kwarto|kuwarto|bakante)\b/i,
  /\bpuno\s+na\b/i,
  /\bwala\s+(?:na|nang|ng)\s+(?:bakante|kwarto|kuwarto|room|slot)/i,
  /\bokupado\b/i,
  /\bnaka-?(?:book|reserve)/i,
  /\b(?:booked|reserved)\s+na\b/i,
];

const AMOUNT = String.raw`(\d[\d,]*(?:\.\d{1,2})?)`;
// A peso figure (₱3,500, PHP 3500, P600, 500 pesos), or a bare number in a rate phrase (2800 per night, 2,800/night).
const PRICES = [
  new RegExp(String.raw`(?:₱|\bPHP|\bPhp|\bP(?=\s?\d))\s?${AMOUNT}`, "g"),
  new RegExp(String.raw`${AMOUNT}\s?(?:pesos?|piso|php)\b`, "gi"),
  new RegExp(String.raw`${AMOUNT}\s*(?:\/\s*|\s(?:per|a|an|each|kada|bawat)\s+)(?:nights?|gabi|pax|persons?|people|heads?|tao|rooms?|guests?|days?|araw)\b`, "gi"),
];
const figures = (text: string) => PRICES.flatMap((re) => [...text.matchAll(re)].map((m) => Number(m[1]!.replace(/,/g, ""))));

/** Every peso figure an entry states: its price, its rules, a fixed deposit, and figures written in its text. */
export function entryPrices(e: KnowledgeEntry): number[] {
  if (!PRICED_KINDS.includes(e.kind)) return [];
  const f = e.fields;
  return [f.price, ...(f.rules ?? []).map((r) => r.price), f.deposit?.mode === "fixed" ? f.deposit.value : undefined, ...figures(e.body)].filter((n): n is number => n !== undefined);
}

// http(s) and www links, and bare domains on common endings. Not after "@", so an email address in the sheet stays whole.
const LINK = /(?<![@\w.])(?:(?:https?:\/\/|www\.)[^\s<>"'()[\]]+|(?:[a-z0-9-]+\.)+(?:com|net|org|ph|io|co|me|ly|gl|xyz|info|app|site|link|to|gg|biz|online|shop)\b(?:\/[^\s<>"'()[\]]*)?)/gi;
const trimLink = (u: string) => u.replace(/[.,!?;:]+$/, "");
const sameLink = (u: string) => trimLink(u).replace(/\/+$/, "").toLowerCase();

export type GuardResult = {
  reply: string;
  /** The whole reply was swapped for a fixed message. */
  replaced: "price" | "availability" | null;
  /** Parts were removed: a link not in the sheet, or a placeholder. */
  flags: ("link" | "placeholder")[];
  needsHuman: boolean;
};

/**
 * The deterministic check on every model reply (plan, "AI safety rules" 1, 2 and 5). Order: remove placeholders and
 * foreign links, then replace the whole reply if it speaks about availability or states a price that no cited entry has.
 */
export function guardReply(reply: string, opts: { entries: KnowledgeEntry[]; cited: string[]; language: Language; links?: string[] }): GuardResult {
  const flags: GuardResult["flags"] = [];
  let out = reply.replace(/\[(?:email|phone)\]|\{\{[\s\S]*?\}\}|\{\{|\}\}/gi, () => (flags.push("placeholder"), ""));

  const allowed = new Set([...(opts.links ?? []), ...opts.entries.flatMap((e) => [e.fields.url ?? "", ...(e.body.match(LINK) ?? [])])].filter(Boolean).map(sameLink));
  out = out.replace(LINK, (m) => {
    const link = trimLink(m);
    if (allowed.has(sameLink(link))) return m;
    flags.push("link");
    return m.slice(link.length);
  });
  out = out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
  const uniqueFlags = [...new Set(flags)];

  const fixed = (why: "price" | "availability"): GuardResult => ({ reply: MESSAGES[why][opts.language], replaced: why, flags: uniqueFlags, needsHuman: true });
  if (AVAILABILITY.some((re) => re.test(out))) return fixed("availability");
  const trusted = new Set(opts.entries.filter((e) => opts.cited.includes(e.id)).flatMap(entryPrices));
  if (figures(out).some((n) => !trusted.has(n))) return fixed("price");
  return { reply: out, replaced: null, flags: uniqueFlags, needsHuman: false };
}

// ---------- stay_quote ----------

type Rule = NonNullable<KnowledgeFields["rules"]>[number];
export type QuoteNight = { date: string; price: number; rule: string | null };
export type StayQuote = {
  entryId: string;
  title: string;
  checkIn: string;
  guests: number;
  nights: QuoteNight[];
  subtotal: number;
  extraGuests: number;
  extraGuestFee: number;
  total: number;
  deposit: number;
};

export class QuoteError extends Error {}

const dayOfYear = (md: string) => {
  const [m, d] = md.split("-").map(Number) as [number, number];
  return (Date.UTC(2024, m - 1, d) - Date.UTC(2024, 0, 1)) / 86_400_000;
};
const inSeason = (md: string, r: Rule) => !r.from || (r.from <= r.to! ? md >= r.from && md <= r.to! : md >= r.from || md <= r.to!);
const seasonDays = (r: Rule) => (r.from ? (dayOfYear(r.to!) - dayOfYear(r.from) + 366) % 366 : 366);

/**
 * Which rule prices a night when several match (decision 0119): a rule with both a season and weekdays beats a season
 * alone, which beats weekdays alone, which beats a rule with neither; between two seasons the shorter one wins (a
 * holiday inside a peak season); on a full tie the rule written first wins. No match means the base price.
 */
function pickRule(rules: Rule[], date: Date): Rule | null {
  const md = date.toISOString().slice(5, 10);
  const day = WEEKDAYS[(date.getUTCDay() + 6) % 7]!;
  const score = (r: Rule) => (r.from ? 2 : 0) + (r.days ? 1 : 0);
  let best: Rule | null = null;
  for (const r of rules) {
    if (!inSeason(md, r) || (r.days && !r.days.includes(day))) continue;
    if (!best || score(r) > score(best) || (score(r) === score(best) && seasonDays(r) < seasonDays(best))) best = r;
  }
  return best;
}

/**
 * The price of a stay from one published room or rate entry. A night rate is per room per night; a person_night rate is
 * per guest per night. Rules without a unit (or with the entry's unit) replace the nightly price; on a per-night room,
 * person and person_night rules are the extra-guest fee for guests above capacity (person once, person_night per night).
 * The deposit is the entry's fixed amount (at most the total), its percent rounded to the peso, or else the full total.
 */
export function quoteStay(entry: KnowledgeEntry, req: { checkIn: string; nights: number; guests: number }): StayQuote {
  const f = entry.fields;
  if (!PRICED_KINDS.includes(entry.kind) || f.price === undefined) throw new QuoteError(`"${entry.title}" has no price in the knowledge sheet.`);
  const unit = f.unit ?? "night";
  if (unit !== "night" && unit !== "person_night") throw new QuoteError(`"${entry.title}" is priced per ${unit}; stay_quote prices a stay per night.`);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(req.checkIn) ? new Date(`${req.checkIn}T00:00:00Z`) : null;
  if (!start || Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== req.checkIn) throw new QuoteError(`The check-in must be a real date as YYYY-MM-DD, not "${req.checkIn}".`);
  if (!Number.isInteger(req.nights) || req.nights < 1 || req.nights > 30) throw new QuoteError("The number of nights must be a whole number from 1 to 30.");
  if (!Number.isInteger(req.guests) || req.guests < 1 || req.guests > 500) throw new QuoteError("The number of guests must be a whole number from 1 to 500.");

  const rules = f.rules ?? [];
  const nightly = rules.filter((r) => r.unit === undefined || r.unit === unit);
  const extra = unit === "night" ? rules.filter((r) => r.unit === "person" || r.unit === "person_night") : [];
  const unused = rules.find((r) => !nightly.includes(r) && !extra.includes(r));
  if (unused) throw new QuoteError(`The rule "${unused.name}" of "${entry.title}" is priced per ${unused.unit}, which stay_quote does not use.`);

  const over = f.capacity === undefined ? 0 : Math.max(0, req.guests - f.capacity);
  if (over > 0 && (unit === "person_night" || !extra.length)) throw new QuoteError(`${req.guests} guests is more guests than "${entry.title}" holds (${f.capacity}), and it has no extra guest fee.`);

  const nights: QuoteNight[] = [];
  let extraGuestFee = 0;
  for (let i = 0; i < req.nights; i++) {
    const date = new Date(start.getTime() + i * 86_400_000);
    const rule = pickRule(nightly, date);
    nights.push({ date: date.toISOString().slice(0, 10), price: rule?.price ?? f.price, rule: rule?.name ?? null });
    if (over > 0) {
      const fee = pickRule(extra, date);
      if (!fee) throw new QuoteError(`No extra guest fee of "${entry.title}" applies on ${nights.at(-1)!.date}.`);
      if (fee.unit === "person_night" || i === 0) extraGuestFee += fee.price * over;
    }
  }
  const subtotal = nights.reduce((sum, n) => sum + n.price * (unit === "person_night" ? req.guests : 1), 0);
  const total = subtotal + extraGuestFee;
  const d = f.deposit;
  const deposit = !d ? total : d.mode === "fixed" ? Math.min(d.value, total) : Math.round((total * d.value) / 100);
  return { entryId: entry.id, title: entry.title, checkIn: req.checkIn, guests: req.guests, nights, subtotal, extraGuests: over, extraGuestFee, total, deposit };
}
