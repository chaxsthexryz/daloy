import { describe, expect, it } from "vitest";
import { definitionSchema } from "./definition";
import { defaultPurchaseAnswers, guidedSetupInput, previewPurchaseRequest, purchaseRequestDefinition, SAMPLE_PURCHASE } from "./purchase-request";

const answers = { ...defaultPurchaseAnswers("owner@example.com"), approver: "boss@example.com", purchasingEmail: "buy@example.com" };

describe("purchase request template", () => {
  it("asks the named approver after the receipt and branches on the decision", () => {
    const def = definitionSchema.parse(purchaseRequestDefinition(answers));
    expect(def.steps.map((s) => `${s.id}:${s.type}`)).toEqual([
      "send_receipt:email",
      "decide:approval",
      "tell_purchasing:email",
      "tell_approved:email",
      "tell_rejected:email",
      "tell_no_decision:email",
    ]);
    const decide = def.steps[1]!;
    expect(decide.type === "approval" && decide.config.approver).toBe("boss@example.com");
    expect(def.edges).toEqual([
      { from: "send_receipt", to: "decide" },
      { from: "decide", to: "tell_purchasing", on: "approved" },
      { from: "tell_purchasing", to: "tell_approved" },
      { from: "decide", to: "tell_rejected", on: "rejected" },
      { from: "decide", to: "tell_no_decision", on: "timeout" },
    ]);
  });

  it("sends from Outlook and adds a Teams note without private details when chosen", () => {
    const def = definitionSchema.parse(purchaseRequestDefinition({ ...answers, outlook: true, teams: true }));
    expect(def.steps.filter((s) => s.type === "outlook").map((s) => s.id)).toEqual(["send_receipt", "tell_purchasing", "tell_approved", "tell_rejected", "tell_no_decision"]);
    const teams = def.steps.find((s) => s.type === "teams")!;
    expect(teams.type === "teams" && teams.config.text).not.toMatch(/trigger\.(name|email|cost|reason)/);
    expect(def.edges).toContainEqual({ from: "tell_purchasing", to: "post_to_teams" });
    expect(def.edges).toContainEqual({ from: "post_to_teams", to: "tell_approved" });
  });

  it("previews every message with a sample reference", () => {
    const p = previewPurchaseRequest({ ...answers, outlook: true, teams: true }, SAMPLE_PURCHASE);
    expect(p.messages.map((m) => m.title)).toContain("Email to purchasing, once approved");
    expect(p.messages.find((m) => m.title.startsWith("Approval"))).toMatchObject({ to: "boss@example.com", via: "kymavo approval link" });
    expect(p.messages.find((m) => m.title.startsWith("Email to purchasing"))).toMatchObject({ to: "buy@example.com", via: "Outlook", subject: "Approved purchase PUR-SAMPLE: Ergonomic chair for the front desk" });
    expect(p.teamsMessage).toBe("Purchase request PUR-SAMPLE was approved: Ergonomic chair for the front desk\nPurchasing has the details. Decisions are made in kymavo by the named approver.");
  });

  it("keeps saved office request setups valid and tells the two templates apart", () => {
    const office = guidedSetupInput.parse({ step: "name", answers: { name: "Office", notifyEmail: "o@example.com", extraFields: [] } });
    expect("template" in office ? office.template : undefined).toBeUndefined();
    const purchase = guidedSetupInput.parse({ template: "purchase-request", step: "approver", answers });
    expect(purchase).toMatchObject({ template: "purchase-request", step: "approver" });
    expect(() => guidedSetupInput.parse({ template: "purchase-request", step: "fields", answers })).toThrow();
  });
});
