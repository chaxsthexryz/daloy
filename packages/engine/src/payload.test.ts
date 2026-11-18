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

describe("datetime fields", () => {
  const at = field({ name: "at", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 });
  const now = Date.UTC(2026, 0, 1);
  const parse = (data: Record<string, unknown>) => parsePayload([at], data, { now });

  it("stores the time with the zone's offset", () => {
    expect(parse({ at: "2027-01-20T14:00" })).toEqual({ ok: true, data: { at: "2027-01-20T14:00:00+08:00" } });
    expect(parse({ at: " 2027-01-20T06:00Z " })).toEqual({ ok: true, data: { at: "2027-01-20T14:00:00+08:00" } });
  });

  it("names the field in each refusal", () => {
    expect(parse({ at: "2027-01-20T32:00" })).toEqual({ ok: false, errors: ["at: is not a real date and time"] });
    expect(parse({ at: "2020-01-20T14:00" })).toEqual({ ok: false, errors: ["at: must be in the future"] });
    expect(parse({ at: "2027-01-20T14:30" })).toEqual({ ok: false, errors: ["at: must start on a 60-minute slot, counted from midnight in Asia/Manila"] });
    expect(parse({})).toEqual({ ok: false, errors: ["at: is required"] });
    expect(parse({ at: 1_800_000_000_000 })).toEqual({ ok: false, errors: ["at: must be a date and time like 2027-01-20T14:00"] });
  });

  it("needs a known IANA timezone, and only datetime fields take timezone or slotMinutes", () => {
    const bad = (f: Record<string, unknown>) => formFieldSchema.safeParse({ name: "at", label: "At", ...f }).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    expect(bad({ type: "datetime" })).toEqual(["timezone: a datetime field needs a timezone such as Asia/Manila"]);
    expect(bad({ type: "datetime", timezone: "+08:00" })).toEqual(["timezone: use an IANA timezone name such as Asia/Manila"]);
    expect(bad({ type: "datetime", timezone: "UTC", slotMinutes: 0 })).toHaveLength(1);
    expect(bad({ type: "datetime", timezone: "UTC", slotMinutes: 1441 })).toHaveLength(1);
    expect(bad({ type: "text", timezone: "UTC" })).toEqual(["type: timezone and slotMinutes are for datetime fields"]);
  });
});

describe("resource fields", () => {
  const therapist = field({ name: "therapist", type: "resource", required: true });
  const resources = [
    { id: "6f1c1b6e-8a5e-4b8f-9d61-0d5f0c0b0a01", name: "Ana" },
    { id: "6f1c1b6e-8a5e-4b8f-9d61-0d5f0c0b0a02", name: "Ben" },
  ];

  it("stores the id with the name it had when the run started", () => {
    expect(parsePayload([therapist], { therapist: resources[1]!.id }, { resources })).toEqual({ ok: true, data: { therapist: resources[1] } });
  });

  it("refuses an id that is not an active resource of this workspace, and any id when none are given", () => {
    const refused = { ok: false, errors: ["therapist: must be one of this workspace's resources"] };
    expect(parsePayload([therapist], { therapist: resources[0]!.id.replace(/01$/, "99") }, { resources })).toEqual(refused);
    expect(parsePayload([therapist], { therapist: "Ana" }, { resources })).toEqual(refused);
    expect(parsePayload([therapist], { therapist: { id: resources[0]!.id, name: "Ana" } }, { resources })).toEqual({ ok: false, errors: ["therapist: must be a resource id"] });
    expect(parsePayload([therapist], { therapist: resources[0]!.id })).toEqual(refused);
  });
});

describe("file fields", () => {
  const photo = field({ name: "photo", type: "file", required: true });
  const extra = field({ name: "extra", type: "file" });
  const ref = (n: number) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, name: `p${n}.png`, type: "png" as const, size: 10 });

  it("leaves file fields out of the payload when there is no files context", () => {
    expect(parsePayload([note, photo], { note: "hi", photo: [{ id: "x" }] })).toEqual({ ok: true, data: { note: "hi" } });
    expect(payloadSchema([photo]).shape).toEqual({});
  });
  it("takes the value from the files context, never from the client", () => {
    const r = parsePayload([note, photo], { photo: "evil" }, { files: { photo: [ref(1)] } });
    expect(r).toEqual({ ok: true, data: { photo: [ref(1)] } });
  });
  it("requires a required file field only when there is a context", () => {
    expect(parsePayload([photo], {}, { files: {} })).toEqual({ ok: false, errors: ["photo: is required"] });
    expect(parsePayload([photo], {}, { files: { photo: [] } })).toEqual({ ok: false, errors: ["photo: is required"] });
    expect(parsePayload([photo], {}).ok).toBe(true);
  });
  it("allows an optional file field to be empty", () => {
    expect(parsePayload([extra], {}, { files: {} })).toEqual({ ok: true, data: {} });
  });
  it("reads an optional file field whose key is absent from the submitted data", () => {
    expect(parsePayload([note, extra], { note: "hi" }, { files: { extra: [ref(2)] } })).toEqual({ ok: true, data: { note: "hi", extra: [ref(2)] } });
  });
  it("allows at most three files per field", () => {
    expect(parsePayload([photo], {}, { files: { photo: [ref(1), ref(2), ref(3)] } }).ok).toBe(true);
    expect(parsePayload([photo], {}, { files: { photo: [ref(1), ref(2), ref(3), ref(4)] } })).toEqual({ ok: false, errors: ["photo: must be at most 3 files"] });
  });
  it("is a form-only field type", () => {
    const def = (trigger: unknown) => definitionSchema.safeParse({ trigger, steps: [{ id: "a", type: "http", config: { method: "GET", url: "https://x.test" } }], edges: [] });
    expect(def({ type: "form", config: { fields: [photo] } }).success).toBe(true);
    const r = def({ type: "webhook", config: { fields: [photo] } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/webhook cannot take files/);
  });
});

describe("drive step", () => {
  const def = (trigger: unknown, config: unknown = {}) => definitionSchema.safeParse({ trigger, steps: [{ id: "save", type: "drive", ...(config === undefined ? {} : { config }) }], edges: [] });
  const withFile = { type: "form", config: { fields: [{ name: "photo", label: "Photo", type: "file" }] } };
  it("needs a form trigger with a file field", () => {
    expect(def(withFile).success).toBe(true);
    expect(def(withFile, undefined).success).toBe(true);
    for (const t of [{ type: "manual", config: {} }, { type: "form", config: { fields: [{ name: "n", label: "N", type: "text" }] } }]) {
      const r = def(t);
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toMatch(/form trigger with at least one file field/);
    }
  });
});
