import * as z from "zod";

/** What a resort writes down for the concierge to answer from (decision 0116). One shape for the console form, the API and the published snapshot. */
export const KNOWLEDGE_KINDS = ["room", "rate", "fee", "faq", "policy", "location", "activity", "arrival", "review_link"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
/** Only these kinds may carry a price. The reply guard (C4) trusts a peso figure only when it comes from one of them. */
export const PRICED_KINDS: readonly KnowledgeKind[] = ["room", "rate", "fee"];
/** What a price is for. "stay" is one price for the whole booking, "day" is a day-tour or entrance fee. */
export const PRICE_UNITS = ["night", "person", "person_night", "stay", "day"] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export const MAX_KNOWLEDGE_ENTRIES = 200;
const MAX_PESOS = 10_000_000;

const pesos = z.number().int().min(0).max(MAX_PESOS);
const unit = z.enum(PRICE_UNITS);
// MM-DD with no year, so a season repeats every year. A season may wrap the new year (12-15 to 01-10).
const monthDay = z.string().regex(/^\d{2}-\d{2}$/).refine((s) => {
  const [m, d] = s.split("-").map(Number) as [number, number];
  const probe = new Date(Date.UTC(2024, m - 1, d));
  return probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}, "must be a real date as MM-DD");

/** A named change to the base price: a season, a weekday rate, or a per-person fee. The first matching rule wins (C4 decides the order). */
const rule = z
  .strictObject({
    name: z.string().trim().min(1).max(60),
    price: pesos,
    unit: unit.optional(),
    from: monthDay.optional(),
    to: monthDay.optional(),
    days: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional(),
  })
  .refine((r) => (r.from === undefined) === (r.to === undefined), "set both from and to, or neither");

const deposit = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("fixed"), value: pesos }),
  z.strictObject({ mode: z.literal("percent"), value: z.number().int().min(1).max(100) }),
]);

export const knowledgeFields = z.strictObject({
  price: pesos.optional(),
  unit: unit.optional(),
  capacity: z.number().int().min(1).max(500).optional(),
  deposit: deposit.optional(),
  rules: z.array(rule).max(12).optional(),
  // A link the bot may send. https only, so a stored link cannot be a script or a plain-http page.
  url: z.url({ protocol: /^https$/ }).max(500).optional(),
});
export type KnowledgeFields = z.output<typeof knowledgeFields>;

const PRICE_KEYS = ["price", "unit", "capacity", "deposit", "rules"] as const;

export const knowledgeEntryInput = z
  .strictObject({
    kind: z.enum(KNOWLEDGE_KINDS),
    title: z.string().trim().min(1, "is required").max(120),
    body: z.string().trim().max(2000).default(""),
    fields: knowledgeFields.default({}),
  })
  .superRefine((e, ctx) => {
    if (!PRICED_KINDS.includes(e.kind)) {
      const stray = PRICE_KEYS.filter((k) => e.fields[k] !== undefined);
      if (stray.length) ctx.addIssue({ code: "custom", path: ["fields"], message: `${stray.join(", ")} only belong on a room, rate or fee` });
    }
    if (!e.body && e.fields.price === undefined && !e.fields.url) ctx.addIssue({ code: "custom", path: ["body"], message: "write some text, a price or a link" });
  });
export type KnowledgeEntryInput = z.output<typeof knowledgeEntryInput>;

/** One entry as published. The id is the draft row's id, so an answer can cite it. */
export type KnowledgeEntry = KnowledgeEntryInput & { id: string };
