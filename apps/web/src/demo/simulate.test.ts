import { describe, expect, it } from "vitest";
import { SCRIPTS } from "./scripts";
import { simulate } from "./simulate";

const script = (id: string) => SCRIPTS.find((s) => s.id === id)!;

describe("simulate", () => {
  it("runs the booking draft to the end, renders the emails and skips the wait", () => {
    const s = script("booking");
    const { definition } = s.draft({ start: "form", who: "me", where: "sheets" });
    const run = simulate(definition, s.sample, {});
    expect(run.state).toBe("succeeded");
    expect(run.steps.map((r) => r.stepId)).toEqual(definition.steps.map((r) => r.id));
    const confirm = run.steps.find((r) => r.stepId === "confirm")!.message!;
    expect(confirm.to).toBe(s.sample.email);
    expect(confirm.text).toContain(s.sample.name);
    expect(confirm.text).not.toContain("{{");
    expect(run.steps.find((r) => r.stepId === "wait")!.note).toMatch(/skipped in the demo/);
    expect(run.steps.find((r) => r.stepId === "log")!.message!.text).toContain(s.sample.name);
  });

  it("stops at an approval until the visitor decides, then follows the branch", () => {
    const s = script("shop");
    const { definition } = s.draft({ start: "webhook", where: "sheets", approve: "yes" });
    const waiting = simulate(definition, s.sample, {});
    expect(waiting.state).toBe("waiting");
    expect(waiting.steps.at(-1)).toMatchObject({ stepId: "approve", state: "waiting", branch: null });
    expect(waiting.steps.at(-1)!.message!.kind).toBe("approval");

    const approved = simulate(definition, s.sample, { approve: "approved" });
    expect(approved.state).toBe("succeeded");
    expect(approved.steps.map((r) => r.stepId)).toEqual(["log", "is_big", "approve", "receipt"]);
    expect(approved.steps[1]!.branch).toBe("true");

    const rejected = simulate(definition, s.sample, { approve: "rejected" });
    expect(rejected.steps.at(-1)!.stepId).toBe("decline");
  });

  it("takes the false branch for a small order and never asks for approval", () => {
    const s = script("shop");
    const { definition } = s.draft({ start: "form", where: "email", approve: "yes" });
    const run = simulate(definition, { ...s.sample, total: "800" }, {});
    expect(run.state).toBe("succeeded");
    expect(run.steps.map((r) => r.stepId)).toEqual(["log", "is_big", "receipt"]);
  });

  it("runs a schedule with no trigger data", () => {
    const s = script("bills");
    const { definition } = s.draft({ when: "1", who: "family" });
    const run = simulate(definition, s.sample, {});
    expect(run.state).toBe("succeeded");
    expect(run.steps[0]!.message!.to).toContain(",");
  });
});
