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

  it("adds the Sheets row and Slack note after the receipt, only when chosen", () => {
    const plain = officeRequestDefinition(defaultAnswers("office@example.com"));
    expect(plain.steps.map((s) => s.type)).toEqual(["email", "email"]);
    const def = definitionSchema.parse(officeRequestDefinition({ ...defaultAnswers("office@example.com"), sheets: true, slack: true }));
    expect(def.steps.map((s) => s.id)).toEqual(["notify_office", "send_receipt", "add_to_sheet", "post_to_slack"]);
    expect(def.edges).toEqual([
      { from: "notify_office", to: "send_receipt" },
      { from: "send_receipt", to: "add_to_sheet" },
      { from: "add_to_sheet", to: "post_to_slack" },
    ]);
    // Everyone in the channel reads the Slack note, so it carries the reference and subject, never the name or email.
    const slack = def.steps[3]!;
    expect(slack.type === "slack" && slack.config.text).not.toMatch(/trigger\.(name|email)/);
  });

  it("previews the sheet row and the Slack note, and reads setups saved before they existed", () => {
    const preview = previewOfficeRequest({ ...defaultAnswers("office@example.com"), sheets: true, slack: true }, SAMPLE_REQUEST);
    expect(preview.sheetRow).toEqual(["REQ-SAMPLE", "(time of the request)", "Rosa Diaz", "rosa.diaz@example.com", "The printer on floor 2 is jammed.", "Floor 2, near the pantry"]);
    expect(preview.slackMessage).toBe("New office request REQ-SAMPLE: The printer on floor 2 is jammed.\nDetails are in kymavo under Requests.");
    expect(officeRequestAnswers.parse({ name: "Office", notifyEmail: "o@example.com", extraFields: [] })).toMatchObject({ sheets: false, slack: false });
  });
});
