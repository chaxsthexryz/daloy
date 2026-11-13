import { describe, expect, it } from "vitest";
import { definitionSchema } from "./definition";
import { defaultAnswers, officeRequestAnswers, officeRequestDefinition, previewOfficeRequest, SAMPLE_REQUEST, setupInput } from "./office-request";

const answers = defaultAnswers("ana@office.test");

describe("office request template", () => {
  it("builds a valid definition with no AI step, so it works with AI disabled", () => {
    for (const extra of [[], ["location"], ["location", "details"]] as const) {
      const def = definitionSchema.parse(officeRequestDefinition({ ...answers, extraFields: [...extra] }));
      expect(def.steps.map((s) => s.type)).toEqual(["email", "email"]);
      expect(def.trigger.type === "form" && def.trigger.config.fields.map((f) => f.name)).toEqual(["name", "email", "summary", ...extra]);
    }
  });

  it("notifies the office address and sends the employee a receipt with the reference", () => {
    const [notify, receipt] = officeRequestDefinition(answers).steps;
    expect(notify!.config).toMatchObject({ to: "ana@office.test" });
    expect(receipt!.config).toMatchObject({ to: "{{trigger.email}}" });
    expect(JSON.stringify(receipt!.config)).toContain("{{trigger.reference}}");
  });

  it("previews the record, the notification and the receipt from sample details", () => {
    const p = previewOfficeRequest({ ...answers, extraFields: ["location"] }, SAMPLE_REQUEST);
    expect(p.reference).toBe("REQ-SAMPLE");
    expect(p.record).toEqual({ reference: "REQ-SAMPLE", subject: SAMPLE_REQUEST.summary, list: answers.name });
    expect(p.notification.to).toBe("ana@office.test");
    expect(p.notification.text).toContain("floor 2");
    expect(p.receipt.to).toBe(SAMPLE_REQUEST.email);
    expect(p.receipt.text).toContain("REQ-SAMPLE");
  });

  it("rejects a bad office address, unknown fields and an unknown setup step", () => {
    expect(officeRequestAnswers.safeParse({ ...answers, notifyEmail: "not-an-email" }).success).toBe(false);
    expect(officeRequestAnswers.safeParse({ ...answers, extraFields: ["salary"] }).success).toBe(false);
    expect(officeRequestAnswers.safeParse({ ...answers, name: "" }).success).toBe(false);
    expect(setupInput.safeParse({ step: "fields", answers }).success).toBe(true);
    expect(setupInput.safeParse({ step: "launch", answers }).success).toBe(false);
  });
});
