import { definitionSchema, lintDefinition } from "@daloy/engine";
import { describe, expect, it } from "vitest";
import { matchScript, SCRIPTS, type Script } from "./scripts";

/** Every way the visitor can answer a script's questions. */
function combinations(script: Script): Record<string, string>[] {
  return script.questions.reduce<Record<string, string>[]>(
    (all, q) => all.flatMap((a) => q.choices.map((c) => ({ ...a, [q.id]: c.value }))),
    [{}],
  );
}

describe("scripted drafts", () => {
  it("has one starter for a freelancer, a small business and an everyday user", () => {
    expect(SCRIPTS.map((s) => s.audience)).toEqual(["Freelancer", "Small business", "Everyday"]);
  });

  for (const script of SCRIPTS) {
    it(`${script.id}: every answer gives a valid definition with no lint warnings`, () => {
      const all = combinations(script);
      expect(all.length).toBeGreaterThan(1);
      for (const answers of all) {
        const draft = script.draft(answers);
        expect(definitionSchema.safeParse(draft.definition).success, JSON.stringify(answers)).toBe(true);
        expect(lintDefinition(definitionSchema.parse(draft.definition)), JSON.stringify(answers)).toEqual([]);
        expect(draft.plan.length).toBe(draft.definition.steps.length);
      }
    });

    it(`${script.id}: asks two or three questions`, () => {
      expect(script.questions.length).toBeGreaterThanOrEqual(2);
      expect(script.questions.length).toBeLessThanOrEqual(3);
    });
  }

  it("changes the draft with the answers", () => {
    const shop = SCRIPTS.find((s) => s.id === "shop")!;
    const types = (a: Record<string, string>) => shop.draft(a).definition.steps.map((s) => s.type);
    expect(types({ start: "webhook", where: "sheets", approve: "yes" })).toContain("approval");
    expect(types({ start: "webhook", where: "slack", approve: "no" })).not.toContain("approval");
    expect(types({ start: "webhook", where: "slack", approve: "no" })).toContain("slack");
  });
});

describe("matchScript", () => {
  it("matches each starter prompt to its own script", () => {
    for (const s of SCRIPTS) expect(matchScript(s.prompt)).toEqual({ script: s, sure: true });
  });

  it("matches plain words that clearly fit one script", () => {
    expect(matchScript("Log every order from my online store and tell me about big ones")).toMatchObject({ script: { id: "shop" }, sure: true });
    expect(matchScript("Remind us to pay the rent and water bill each month")).toMatchObject({ script: { id: "bills" }, sure: true });
  });

  it("offers the nearest script without claiming a match when the words fit weakly", () => {
    expect(matchScript("Tell me when a customer writes")).toMatchObject({ script: { id: "shop" }, sure: false });
  });

  it("offers nothing when no word fits", () => {
    expect(matchScript("Post the weather to my blog")).toEqual({ script: undefined, sure: false });
    expect(matchScript("")).toEqual({ script: undefined, sure: false });
  });
});
