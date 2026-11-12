import { describe, expect, it } from "vitest";
import { definitionSchema } from "./definition";
import { TEMPLATES } from "./templates";

describe("starter templates", () => {
  it("has the three templates PROJECT.md asks for", () => {
    expect(TEMPLATES.map((t) => t.slug)).toEqual(["inquiry-triage", "invoice-follow-up", "no-show-follow-up"]);
  });

  it.each(TEMPLATES.map((t) => [t.slug, t] as const))("%s is a valid definition", (_slug, t) => {
    const result = definitionSchema.safeParse(t.definition);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });
});
