import { describe, expect, it } from "vitest";
import { definitionSchema } from "./definition";
import { entryStep, nextStep } from "./graph";

const def = definitionSchema.parse({
  trigger: { type: "manual", config: {} },
  steps: [
    { id: "fetch", type: "http", config: {} },
    { id: "check", type: "condition", config: { condition: { left: "{{trigger.ok}}", op: "eq", right: true } } },
    { id: "yes", type: "email", config: {} },
    { id: "no", type: "email", config: {} },
  ],
  edges: [
    { from: "check", to: "yes", on: "true" },
    { from: "fetch", to: "check" },
    { from: "check", to: "no", on: "false" },
  ],
});

describe("entryStep", () => {
  it("returns the step with no incoming edge, wherever it sits in the list", () => {
    expect(entryStep({ ...def, steps: [...def.steps].reverse() }).id).toBe("fetch");
  });
});

describe("nextStep", () => {
  it("follows the unlabelled edge of a plain step", () => {
    expect(nextStep(def, "fetch")?.id).toBe("check");
  });

  it("follows the edge for the branch a step took", () => {
    expect(nextStep(def, "check", "true")?.id).toBe("yes");
    expect(nextStep(def, "check", "false")?.id).toBe("no");
  });

  it("returns undefined at the end of the flow", () => {
    expect(nextStep(def, "yes")).toBeUndefined();
  });

  it("returns undefined when the taken branch has no edge", () => {
    const partial = { ...def, edges: def.edges.filter((e) => e.on !== "false") };
    expect(nextStep(partial, "check", "false")).toBeUndefined();
  });

  it("throws when a branching step reports no branch", () => {
    expect(() => nextStep(def, "check")).toThrow(/needs a branch/);
  });

  it("throws for an unknown step id", () => {
    expect(() => nextStep(def, "ghost")).toThrow(/unknown step/);
  });
});
