import { KNOWLEDGE_KINDS, PRICED_KINDS, PRICE_UNITS, WEEKDAYS, type KnowledgeEntry, type KnowledgeEntryInput, type KnowledgeKind, type PriceUnit } from "@daloy/engine";

export { KNOWLEDGE_KINDS, PRICE_UNITS, WEEKDAYS };
export const isPriced = (kind: KnowledgeKind) => PRICED_KINDS.includes(kind);

/** The form keeps every field as text, so an empty box means "not set" and nothing is guessed. */
export type RuleForm = { name: string; price: string; unit: "" | PriceUnit; from: string; to: string; days: string[] };
export type EntryForm = {
  kind: KnowledgeKind; title: string; body: string; url: string;
  price: string; unit: "" | PriceUnit; capacity: string;
  deposit: "" | "fixed" | "percent"; depositValue: string; rules: RuleForm[];
};

export const emptyRule = (): RuleForm => ({ name: "", price: "", unit: "", from: "", to: "", days: [] });
export const emptyForm = (kind: KnowledgeKind = "room"): EntryForm => ({ kind, title: "", body: "", url: "", price: "", unit: kind === "room" ? "night" : "", capacity: "", deposit: "", depositValue: "", rules: [] });

export function toForm(e: KnowledgeEntry): EntryForm {
  const f = e.fields;
  return {
    kind: e.kind, title: e.title, body: e.body, url: f.url ?? "",
    price: f.price?.toString() ?? "", unit: f.unit ?? "", capacity: f.capacity?.toString() ?? "",
    deposit: f.deposit?.mode ?? "", depositValue: f.deposit?.value.toString() ?? "",
    rules: (f.rules ?? []).map((r) => ({ name: r.name, price: r.price.toString(), unit: r.unit ?? "", from: r.from ?? "", to: r.to ?? "", days: [...(r.days ?? [])] })),
  };
}

const num = (s: string) => (s.trim() === "" ? undefined : Number(s));

/** What the API takes. Price fields are sent only for rooms, rates and fees; anything left empty is left out. */
export function toInput(form: EntryForm): KnowledgeEntryInput {
  const priced = isPriced(form.kind);
  const fields: KnowledgeEntryInput["fields"] = {};
  if (form.url.trim()) fields.url = form.url.trim();
  if (priced) {
    const price = num(form.price);
    if (price !== undefined) fields.price = price;
    if (form.unit) fields.unit = form.unit;
    const capacity = num(form.capacity);
    if (capacity !== undefined) fields.capacity = capacity;
    if (form.deposit) fields.deposit = { mode: form.deposit, value: Number(form.depositValue) } as never;
    const rules = form.rules.map((r) => ({
      name: r.name.trim(), price: Number(r.price),
      ...(r.unit ? { unit: r.unit } : {}), ...(r.from ? { from: r.from.trim() } : {}), ...(r.to ? { to: r.to.trim() } : {}), ...(r.days.length ? { days: r.days as (typeof WEEKDAYS)[number][] } : {}),
    }));
    if (rules.length) fields.rules = rules;
  }
  return { kind: form.kind, title: form.title.trim(), body: form.body.trim(), fields };
}

const pesos = (n: number) => `PHP ${n.toLocaleString("en-PH")}`;

/** One line for the list: the base price, how many named rules sit on it, or the start of the text. Words come from the caller so they can be translated. */
export function summaryOf(e: KnowledgeEntry, words: { per: (unit: PriceUnit) => string; rules: (n: number) => string }): string {
  const f = e.fields;
  const parts: string[] = [];
  if (f.price !== undefined) parts.push(`${pesos(f.price)}${f.unit ? ` ${words.per(f.unit)}` : ""}`);
  if (f.rules?.length) parts.push(words.rules(f.rules.length));
  if (!parts.length) parts.push(e.body.length > 110 ? `${e.body.slice(0, 107)}...` : e.body || (f.url ?? ""));
  return parts.join(", ");
}
