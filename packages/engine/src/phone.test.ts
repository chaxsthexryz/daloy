import { describe, expect, it } from "vitest";
import { definitionSchema, normalizePhMobile, SMS_MAX_CHARS, smsConfigSchema } from "./index";

describe("normalizePhMobile", () => {
  it("normalizes +639, 639, and 09 Philippine mobile numbers to +639XXXXXXXXX", () => {
    expect(normalizePhMobile("+639171234567")).toEqual({ ok: true, value: "+639171234567" });
    expect(normalizePhMobile("639171234567")).toEqual({ ok: true, value: "+639171234567" });
    expect(normalizePhMobile("09171234567")).toEqual({ ok: true, value: "+639171234567" });
    expect(normalizePhMobile("  0917 123 4567  ")).toEqual({ ok: true, value: "+639171234567" });
    expect(normalizePhMobile("+63 917-123-4567")).toEqual({ ok: true, value: "+639171234567" });
  });

  it("rejects non-Philippine, landline, and malformed numbers", () => {
    for (const bad of [
      "",
      "   ",
      "+14155550100",
      "+63281234567",
      "08171234567",
      "0917123456",
      "091712345678",
      "+63917123456",
      "9171234567",
      "0917abc4567",
      "-09171234567",
      "09171234567-",
    ]) {
      const r = normalizePhMobile(bad);
      expect(r.ok, `expected "${bad}" to fail`).toBe(false);
    }
  });
});

describe("sms step schema", () => {
  it("accepts template expressions in to and message and an optional Sender ID", () => {
    const parsed = smsConfigSchema.parse({
      to: "{{trigger.phone}}",
      message: "Hi {{trigger.name}}, your booking is confirmed.",
      senderId: "LimDental",
    });
    expect(parsed).toEqual({
      to: "{{trigger.phone}}",
      message: "Hi {{trigger.name}}, your booking is confirmed.",
      senderId: "LimDental",
    });

    const minimal = smsConfigSchema.parse({ to: "09171234567", message: "Confirmed." });
    expect(minimal.senderId).toBeUndefined();
    expect(SMS_MAX_CHARS).toBe(670);
  });

  it("rejects empty fields and invalid Sender IDs", () => {
    expect(smsConfigSchema.safeParse({ to: "", message: "Hello" }).success).toBe(false);
    expect(smsConfigSchema.safeParse({ to: "09171234567", message: "" }).success).toBe(false);
    expect(smsConfigSchema.safeParse({ to: "09171234567", message: "Hi", senderId: "TooLongSenderId12" }).success).toBe(false);
    expect(smsConfigSchema.safeParse({ to: "09171234567", message: "Hi", senderId: "Bad!Sender" }).success).toBe(false);
  });

  it("accepts an sms step inside a workflow definition", () => {
    const def = definitionSchema.parse({
      trigger: { type: "manual", config: {} },
      steps: [{ id: "text_customer", type: "sms", config: { to: "{{trigger.phone}}", message: "Confirmed." } }],
      edges: [],
    });
    expect(def.steps[0]?.type).toBe("sms");
  });
});
