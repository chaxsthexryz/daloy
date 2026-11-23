import { definitionSchema, stepLabel } from "@daloy/engine";
import { describe, expect, it } from "vitest";
import { addStep, blankDraft } from "./lib/graph";
import { insertables, setupLeft } from "./lib/editor";
import { translate } from "./lib/locale";

// Phase B1: the Read a web page step in the editor.
describe("the Read a web page step in the editor", () => {
  it("adds a step that already saves, with the sample address to replace", () => {
    const { draft } = addStep(blankDraft(), "read_page");
    expect(draft.steps[0]).toMatchObject({ type: "read_page", config: { url: expect.stringMatching(/^https:/), maxChars: 4000 } });
    expect(definitionSchema.safeParse(draft).success).toBe(true);
  });
  it("needs no connected app", () => {
    const { draft } = addStep(blankDraft(), "read_page");
    expect(setupLeft(draft, new Set())).toEqual([]);
  });
  it("offers its five outputs to the next step", () => {
    const first = addStep(blankDraft(), "read_page");
    const second = addStep(first.draft, "condition", { id: first.id });
    const options = insertables(second.draft, second.id);
    for (const k of ["title", "text", "value", "previous", "changed"]) expect(options).toContain(`{{steps.${first.id}.output.${k}}}`);
  });
  it("has a name in both languages", () => {
    expect(stepLabel("read_page")).toBe("Read a web page");
    expect(translate("tl", "Read a web page")).toBe("Magbasa ng web page");
  });
});
