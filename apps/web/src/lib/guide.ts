/** Setup guide state for the editor (roadmap R2b): where the owner is between connecting an app and turning the flow on. */
export type SampleResult = { key: string; runId: string };
export type TestState = "none" | "stale" | "running" | "passed" | "failed";

/**
 * What the last sample test says about the draft on screen. `key` is the draft as JSON when the test ran, so any edit
 * since then makes the result out of date instead of letting an old pass vouch for new settings.
 */
export function testState(draftKey: string, sample: SampleResult | null, runState: string | null): TestState {
  if (!sample) return "none";
  if (sample.key !== draftKey) return "stale";
  if (runState === "succeeded") return "passed";
  if (runState === "failed" || runState === "cancelled") return "failed";
  return "running";
}

export type GuideKey = "connect" | "message" | "explain" | "try" | "turnon";
export type GuideStep = { key: GuideKey; done: boolean };

/** The five steps in order. Each is done on its own facts, so a seller can see what is left without a forced sequence. */
export function guideSteps(f: { missingApps: number; problems: number; explained: boolean; test: TestState; live: boolean }): GuideStep[] {
  return [
    { key: "connect", done: f.missingApps === 0 },
    { key: "message", done: f.problems === 0 },
    { key: "explain", done: f.explained },
    { key: "try", done: f.test === "passed" },
    { key: "turnon", done: f.live },
  ];
}
