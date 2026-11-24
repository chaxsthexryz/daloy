import { definitionSchema, stepJsonSchemas } from "@daloy/engine";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageContext } from "../Language";
import { SchemaForm, type JsonSchema } from "../SchemaForm";
import { SwitchCases } from "../SwitchCases";
import { insertables, openExits } from "./editor";
import { addStep, blankDraft, connectSteps, duplicateStep, layout, setDisabled, toFlow, type Draft } from "./graph";
import { runFlow } from "./run-flow";

const valid = (d: Draft) => {
  const r = definitionSchema.safeParse(d);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("E4 editor graph and canvas helpers", () => {
  it("supports switch dynamic branches in addStep, connectSteps, openExits, layout, and toFlow", () => {
    let d = addStep(blankDraft(), "switch").draft;
    d = {
      ...d,
      steps: d.steps.map((s) =>
        s.id === "switch_1"
          ? {
              ...s,
              type: "switch" as const,
              config: {
                value: "{{trigger.tier}}",
                cases: [
                  { label: "vip", equals: "vip" },
                  { label: "std", equals: "standard" },
                ],
              },
            }
          : s,
      ),
    };
    expect(openExits(d, "switch_1")).toEqual([{ on: "vip" }, { on: "std" }, { on: "default" }]);
    d = addStep(d, "email", { id: "switch_1", on: "std" }).draft;
    d = addStep(d, "email", { id: "switch_1", on: "vip" }).draft;
    d = addStep(d, "email", { id: "switch_1", on: "default" }).draft;
    expect(valid(d)).toEqual([]);
    expect(openExits(d, "switch_1")).toEqual([]);
    expect(duplicateStep(d, "switch_1")).toEqual({ error: { id: "branching", step: "switch_1" } });
    expect(setDisabled(d, "switch_1", true)).toEqual(d);

    const pos = layout(d);
    expect(pos.email_2!.x).toBeLessThan(pos.email_1!.x);
    expect(pos.email_1!.x).toBeLessThan(pos.email_3!.x);

    const flow = toFlow(d, "switch_1");
    expect(flow.nodes.find((n) => n.id === "switch_1")!.data.branches).toEqual(["vip", "std", "default"]);
    expect(connectSteps(d, "switch_1", "unknown", "email_1")).toEqual({ error: { id: "branch", from: "switch_1" } });
  });

  it("supports onError failed_edge exits, connection, layout, and runFlow state", () => {
    const base: Draft = {
      trigger: { type: "manual", config: {} },
      steps: [
        { id: "call", type: "http", onError: "failed_edge", config: { method: "GET", url: "https://example.com", headers: {} } },
        { id: "ok", type: "delay", config: { seconds: 5 } },
        { id: "fallback", type: "delay", config: { seconds: 5 } },
      ],
      edges: [{ from: "call", to: "ok" }],
    };
    expect(openExits(base, "call")).toEqual([{ on: "failed" }]);
    const connected = connectSteps(base, "call", "failed", "fallback");
    expect("draft" in connected).toBe(true);
    if (!("draft" in connected)) return;
    expect(valid(connected.draft)).toEqual([]);
    expect(openExits(connected.draft, "call")).toEqual([]);

    const pos = layout(connected.draft);
    expect(pos.ok!.x).toBeLessThan(pos.fallback!.x);

    const flow = toFlow(connected.draft, null);
    expect(flow.nodes.find((n) => n.id === "call")!.data.hasFailedEdge).toBe(true);

    const rf = runFlow(connected.draft, {
      state: "succeeded",
      needsReview: false,
      steps: [
        { stepId: "call", state: "failed", branch: "failed", createdAt: "2026-11-24T00:00:01Z" },
        { stepId: "fallback", state: "succeeded", branch: null, createdAt: "2026-11-24T00:00:02Z" },
      ],
    });
    expect(rf.nodes.call).toBe("problem");
    expect(rf.edges["call:failed"]).toBe("done");
    expect(rf.edges["call:next"]).toBe("skipped");
  });

  it("lists transform and onError outputs in insertables and renders SwitchCases and Sheets columns", () => {
    const d: Draft = {
      trigger: { type: "manual", config: {} },
      steps: [
        { id: "fmt", type: "transform", config: { op: "format_peso", value: "{{trigger.amount}}" } },
        { id: "obj", type: "transform", config: { op: "pick", fields: { total: "{{steps.fmt.output.result}}" } } },
        { id: "req", type: "http", onError: "skip", config: { method: "GET", url: "https://example.com", headers: {} } },
        { id: "end", type: "delay", config: { seconds: 1 } },
      ],
      edges: [
        { from: "fmt", to: "obj" },
        { from: "obj", to: "req" },
        { from: "req", to: "end" },
      ],
    };
    const vars = insertables(d, "end");
    expect(vars).toContain("{{steps.fmt.output.result}}");
    expect(vars).toContain("{{steps.fmt.output.plain}}");
    expect(vars).toContain("{{steps.obj.output.total}}");
    expect(vars).toContain("{{steps.req.output.error}}");

    const switchHtml = renderToStaticMarkup(
      createElement(
        LanguageContext.Provider,
        { value: { language: "tl", setLanguage: () => undefined } },
        createElement(SwitchCases, { cases: [{ label: "vip", equals: "VIP" }], onChange: () => undefined }),
      ),
    );
    expect(switchHtml).toContain("Mga kaso");

    const sheetsHtml = renderToStaticMarkup(
      createElement(
        LanguageContext.Provider,
        { value: { language: "en", setLanguage: () => undefined } },
        createElement(SchemaForm, { schema: stepJsonSchemas().sheets as JsonSchema, value: { columns: ["a"], header: ["Name"] }, onChange: () => undefined }),
      ),
    );
    expect(sheetsHtml).toContain("Columns");
    expect(sheetsHtml).toContain("Header row");
    expect(sheetsHtml).toContain("Rows list");
  });
});
