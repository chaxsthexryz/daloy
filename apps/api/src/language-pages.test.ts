import { describe, expect, it } from "vitest";
import { answerAll, explainFailure, type AskFacts, type Facts } from "./explain";
import { page, renderForm } from "./public";

const facts: Facts = { runState: "failed", preview: false, step: null, deliveries: [], lint: [] };
describe("Tagalog fixed answers", () => {
  it("keeps the English default and translates fixed fallback and lint", () => {
    expect(explainFailure(facts)).toEqual(explainFailure(facts, "en"));
    expect(explainFailure(facts, "tl").headline).toBe("Hindi matukoy ng kymavo kung bakit ito huminto.");
    expect(explainFailure({ ...facts, lint: [{ rule: "unreachable_step", count: 1 }] }, "tl").lines).toContain("May bahagi ng automation na hindi maaabot, kaya hindi ito tatakbo.");
  });
  it("keeps provider names, attempts and destinations in translated delivery guidance", () => {
    const result = explainFailure({ ...facts, deliveries: [{ provider: "slack", state: "failed", errorKind: "quota", attempts: 3 }] }, "tl");
    expect(result.headline).toContain("Slack");
    expect(result.lines[0]).toContain("3");
    expect(result.lines[0]).toContain("Wala ka munang kailangang gawin");
    expect(explainFailure({ ...facts, deliveries: [{ provider: "slack", state: "failed", errorKind: "auth", attempts: 1 }] }, "tl").fix).toEqual({ href: "#/apps", label: "Tingnan ang koneksyon" });
  });
  it("translates the three answers without changing closed-set facts", () => {
    const input: AskFacts = { ...facts, plainState: "problem", steps: [] };
    const before = structuredClone(input);
    const answers = answerAll(input, "tl");
    expect(answers.happened.headline).toBe("Huminto ang request na ito dahil may problema.");
    expect(answers.next.headline).toBe("Ano ang susunod na gagawin.");
    expect(input).toEqual(before);
  });
});
describe("Tagalog hosted form labels", () => {
  it("preserves user copy and field values, sets document language", () => {
    const html = renderForm([{ name: "summary", type: "text", label: "Original English label", required: true }, { name: "room", type: "resource", label: "Room", required: false }], [{ id: "room-id", name: "Original room" }], undefined, "Original business", "tl");
    expect(html).toContain('lang="tl"');
    expect(html).toContain("Original English label");
    expect(html).toContain("Original business");
    expect(html).toContain("Original room");
    expect(html).toContain("Pumili ng isa");
    expect(html).toContain(">Ipadala</button>");
    expect(page("text")).toContain('lang="en"');
  });
});
