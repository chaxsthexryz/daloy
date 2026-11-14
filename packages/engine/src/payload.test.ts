import { describe, expect, it } from "vitest";
import { definitionSchema, formFieldSchema, parsePayload, payloadSchema, triggerFields, type FormField } from "./definition";

const field = (f: Partial<FormField> & Pick<FormField, "name" | "type">): FormField => formFieldSchema.parse({ label: f.name, ...f });
const budget = field({ name: "budget", type: "number", required: true, min: 0 });
const discount = field({ name: "discount", type: "number", required: true, min: 0, max: 50 });
const seats = field({ name: "seats", type: "number", integer: true });
const note = field({ name: "note", type: "text" });
const email = field({ name: "email", type: "email", required: true });

const errors = (fields: FormField[], data: Record<string, unknown>) => {
  const r = parsePayload(fields, data);
  return r.ok ? [] : r.errors;
};

describe("number field options", () => {
  it("keeps min, max and integer when a definition is saved", () => {
    expect(discount).toMatchObject({ min: 0, max: 50 });
    expect(seats).toMatchObject({ integer: true });
  });
  it("refuses min above max", () => {
    expect(formFieldSchema.safeParse({ name: "n", label: "N", type: "number", min: 10, max: 5 }).success).toBe(false);
  });
  it("refuses number options on a text field", () => {
    const r = formFieldSchema.safeParse({ name: "n", label: "N", type: "text", min: 1 });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/number fields/);
  });
  it("refuses infinite limits", () => {
    expect(formFieldSchema.safeParse({ name: "n", label: "N", type: "number", max: Infinity }).success).toBe(false);
  });
});

describe("parsePayload", () => {
  it("accepts the exact boundaries", () => {
    expect(parsePayload([discount], { discount: 0 })).toEqual({ ok: true, data: { discount: 0 } });
    expect(parsePayload([discount], { discount: "50" })).toEqual({ ok: true, data: { discount: 50 } });
  });
  it("names the field and the limit that was broken", () => {
    expect(errors([budget], { budget: -5000 })).toEqual(["budget: must be at least 0"]);
    expect(errors([discount], { discount: "80" })).toEqual(["discount: must be at most 50"]);
    expect(errors([discount], { discount: 50.01 })).toEqual(["discount: must be at most 50"]);
    expect(errors([seats], { seats: 2.5 })).toEqual(["seats: must be a whole number"]);
  });
  it("says a required field is missing, whether absent, empty or blank", () => {
    expect(errors([budget], {})).toEqual(["budget: is required"]);
    expect(errors([budget], { budget: "" })).toEqual(["budget: is required"]);
    expect(errors([email, note], { email: "  " })).toEqual(["email: is required"]);
    expect(errors([field({ name: "order_id", type: "text", required: true })], { order_id: "   " })).toEqual(["order_id: is required"]);
  });
  it("refuses text that is not a plain decimal number", () => {
    for (const v of ["45,000", "Infinity", "0x10", "1e400", "12abc", true]) expect(errors([budget], { budget: v }), String(v)).toEqual(["budget: must be a number"]);
  });
  it("reads plain number text, with spaces and exponents", () => {
    expect(parsePayload([budget], { budget: " 30000 " })).toEqual({ ok: true, data: { budget: 30_000 } });
    expect(parsePayload([budget], { budget: "1.5e3" })).toEqual({ ok: true, data: { budget: 1500 } });
  });
  it("treats null and empty as not given for an optional field", () => {
    expect(parsePayload([seats, note], { seats: null, note: "" })).toEqual({ ok: true, data: {} });
  });
  it("lists every broken field at once", () => {
    expect(errors([field({ name: "order_id", type: "text", required: true }), field({ name: "amount", type: "number", required: true, min: 0.01 })], { order_id: "", amount: -10 })).toEqual([
      "order_id: is required",
      "amount: must be at least 0.01",
    ]);
  });
  it("checks emails and text length", () => {
    expect(errors([email], { email: "not-an-email" })).toEqual(["email: must be an email address"]);
    expect(errors([note], { note: "x".repeat(501) })).toEqual(["note: must be at most 500 characters"]);
    expect(errors([note], { note: 42 })).toEqual(["note: must be text"]);
  });
  it("drops keys that are not fields", () => {
    expect(payloadSchema([note]).parse({ note: "hi", _website: "spam" })).toEqual({ note: "hi" });
  });
});

describe("triggerFields", () => {
  const def = (trigger: unknown) => definitionSchema.parse({ trigger, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }] });
  it("returns form fields and optional webhook fields", () => {
    expect(triggerFields(def({ type: "form", config: { fields: [{ name: "a", label: "A", type: "text" }] } }).trigger)).toHaveLength(1);
    expect(triggerFields(def({ type: "webhook", config: { fields: [{ name: "event_id", label: "Event", type: "text", required: true }] } }).trigger)).toHaveLength(1);
    expect(triggerFields(def({ type: "webhook", config: {} }).trigger)).toBeUndefined();
    expect(triggerFields(def({ type: "manual", config: {} }).trigger)).toBeUndefined();
  });
  it("refuses duplicate webhook field names", () => {
    const f = { name: "a", label: "A", type: "text" };
    expect(definitionSchema.safeParse({ trigger: { type: "webhook", config: { fields: [f, f] } }, steps: [{ id: "a", type: "delay", config: { seconds: 1 } }] }).success).toBe(false);
  });
});
