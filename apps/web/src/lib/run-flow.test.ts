import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Draft } from "./graph";
import { handledFailure, runFlow, STATUS, type FlowRun } from "./run-flow";

// trigger -> check -(true)-> send -> done_step ; check -(false)-> other
const draft: Draft = {
  trigger: { type: "manual", config: {} },
  steps: [
    { id: "check", type: "condition", config: { condition: { left: "{{trigger.n}}", op: "gt", right: 1 } } },
    { id: "send", type: "http", config: { method: "POST", url: "https://example.com", headers: {}, body: "" } },
    { id: "tail", type: "delay", config: { seconds: 5 } },
    { id: "other", type: "delay", config: { seconds: 5 } },
  ],
  edges: [
    { from: "check", to: "send", on: "true" },
    { from: "check", to: "other", on: "false" },
    { from: "send", to: "tail" },
  ],
};

let t = 0;
const row = (stepId: string, state: string, branch: string | null = null) => ({ stepId, state, branch, createdAt: new Date(2026, 0, 1, 0, 0, t++).toISOString() });
const run = (state: string, steps: FlowRun["steps"], needsReview = false): FlowRun => ({ state, needsReview, steps });

describe("runFlow nodes", () => {
  it("maps each step row state to a node state", () => {
    const r = runFlow(draft, run("running", [row("check", "succeeded", "true"), row("send", "running")]));
    expect(r.nodes).toMatchObject({ trigger: "done", check: "done", send: "working", tail: "idle", other: "idle" });
  });

  it("maps failed to problem and waiting to waiting", () => {
    expect(runFlow(draft, run("failed", [row("check", "succeeded", "true"), row("send", "failed")])).nodes.send).toBe("problem");
    expect(runFlow(draft, run("waiting", [row("check", "succeeded", "true"), row("send", "succeeded"), row("tail", "waiting")])).nodes.tail).toBe("waiting");
  });

  it("uses the newest attempt of a retried step", () => {
    const failedThenOk = run("succeeded", [row("check", "succeeded", "true"), row("send", "failed"), row("send", "succeeded")]);
    expect(runFlow(draft, failedThenOk).nodes.send).toBe("done");
    const okThenRunning = run("running", [row("check", "succeeded", "true"), row("send", "failed"), row("send", "running")]);
    expect(runFlow(draft, okThenRunning).nodes.send).toBe("working");
  });

  it("shows a turned-off step as skipped and carries the flow through it (decision 0097)", () => {
    const r = runFlow(draft, run("running", [row("check", "succeeded", "true"), row("send", "skipped")]));
    expect(r.nodes.send).toBe("skipped");
    expect(r.edges).toMatchObject({ "check:true": "done", "send:next": "flowing" });
  });

  it("marks the last unfinished step Needs you when the run needs review", () => {
    const r = runFlow(draft, run("needs_review", [row("check", "succeeded", "true"), row("send", "failed")], true));
    expect(r.nodes.send).toBe("needs_you");
    // A delivery in review after every step succeeded changes no step.
    expect(runFlow(draft, run("succeeded", [row("check", "succeeded", "true"), row("send", "succeeded")], true)).nodes.send).toBe("done");
  });

  it("is all idle without a run, and ignores step ids the draft no longer has", () => {
    const none = runFlow(draft, null);
    expect(Object.values(none.nodes).every((s) => s === "idle")).toBe(true);
    expect(Object.values(none.edges).every((s) => s === "idle")).toBe(true);
    expect(() => runFlow(draft, run("running", [row("gone", "running")]))).not.toThrow();
  });
});

describe("runFlow edges", () => {
  it("flows into the step that is working and shows done edges behind it", () => {
    const r = runFlow(draft, run("running", [row("check", "succeeded", "true"), row("send", "running")]));
    expect(r.edges).toMatchObject({ "trigger->entry": "done", "check:true": "flowing", "check:false": "skipped", "send:next": "idle" });
  });

  it("flows from the trigger while the first step has no row yet", () => {
    expect(runFlow(draft, run("pending", [])).edges["trigger->entry"]).toBe("flowing");
    expect(runFlow(draft, run("running", [row("check", "running")])).edges["trigger->entry"]).toBe("flowing");
  });

  it("flows from a finished step to a next step that has no row yet", () => {
    const r = runFlow(draft, run("running", [row("check", "succeeded", "true"), row("send", "succeeded")]));
    expect(r.edges["send:next"]).toBe("flowing");
  });

  it("keeps an edge into a failed or waiting step done, not flowing", () => {
    expect(runFlow(draft, run("failed", [row("check", "succeeded", "true"), row("send", "failed")])).edges["check:true"]).toBe("done");
    const waiting = runFlow(draft, run("waiting", [row("check", "succeeded", "true"), row("send", "succeeded"), row("tail", "waiting")]));
    expect(waiting.edges["send:next"]).toBe("done");
  });

  it("flows nowhere once the run is finished", () => {
    const stopped = runFlow(draft, run("cancelled", [row("check", "succeeded", "true")]));
    expect(Object.values(stopped.edges)).not.toContain("flowing");
    expect(stopped.edges["check:true"]).toBe("idle");
  });

  it("marks the branch not taken", () => {
    const r = runFlow(draft, run("succeeded", [row("check", "succeeded", "false"), row("other", "succeeded")]));
    expect(r.edges).toMatchObject({ "check:false": "done", "check:true": "skipped", "send:next": "idle" });
  });
});

describe("status text", () => {
  it("gives every state words and a symbol, so colour is never the only signal", () => {
    for (const s of Object.values(STATUS)) {
      expect(s.label.length).toBeGreaterThan(2);
      expect(s.symbol.length).toBeGreaterThan(0);
    }
    expect(new Set(Object.values(STATUS).map((s) => s.label)).size).toBe(Object.keys(STATUS).length);
  });
});

// WCAG 2.x contrast of the state colours in styles.css, light and dark.
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
const schemes = {
  light: tokens(/^:root \{([^}]*)\}/m.exec(css)![1]!),
  dark: { ...tokens(/^:root \{([^}]*)\}/m.exec(css)![1]!), ...tokens(/^:root\[data-theme="dark"\] \{([^}]*)\}/m.exec(css)![1]!) },
};
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe.each(Object.entries(schemes))("state colours in %s mode", (_name, tk) => {
  const colours = ["ok", "danger", "warn", "muted", "accent"] as const;
  it.each(colours)("%s text is at least 4.5:1 on a node and on the page", (c) => {
    expect(contrast(tk[c]!, tk.surface!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tk[c]!, tk.bg!)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(colours)("%s lines are at least 3:1 on the canvas", (c) => {
    expect(contrast(tk[c]!, tk.bg!)).toBeGreaterThanOrEqual(3);
  });
  it("disabled button text is at least 4.5:1 on disabled background", () => {
    expect(contrast(tk["disabled-fg"]!, tk["disabled-bg"]!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("editor connection progress track contrast", () => {
  const editorCss = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const lightEditor = tokens(/^\.a7-editor \{([^}]*)\}/m.exec(editorCss)![1]!);
  const darkEditor = tokens(/^:root\[data-theme="dark"\] \.a7-editor \{([^}]*)\}/m.exec(editorCss)![1]!);

  it.each([
    ["light", lightEditor],
    ["dark", darkEditor],
  ])("track segment meets 3:1 against banner background in %s mode", (_mode, tk) => {
    expect(contrast(tk["a7-bar-off"]!, tk["a7-bar"]!)).toBeGreaterThanOrEqual(3);
  });
});

describe("handledFailure (T3)", () => {
  it("names a failed step the run skipped past or routed around, and nothing else", () => {
    expect(handledFailure({ state: "skipped", branch: null, output: { skipped: true, error: "x" } })).toMatch(/skipped it and carried on/);
    expect(handledFailure({ state: "failed", branch: "failed", output: { failed: true } })).toMatch(/took its failed path/);
    expect(handledFailure({ state: "skipped", branch: null, output: { skipped: "This step is turned off in the editor." } })).toBeNull();
    expect(handledFailure({ state: "failed", branch: null, output: null })).toBeNull();
  });
});
