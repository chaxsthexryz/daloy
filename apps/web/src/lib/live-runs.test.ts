import { describe, expect, it } from "vitest";
import type { RunSummary } from "../api";
import { diffLiveRuns, liveRunToast, type LiveRunSnapshot } from "./live-runs";
import { translate } from "./locale";

const makeRun = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  id: "11111111-1111-1111-1111-111111111111",
  workflowId: "22222222-2222-2222-2222-222222222222",
  workflowName: "Log GCash receipts from Telegram",
  reference: null,
  version: 1,
  state: "running",
  test: false,
  live: false,
  error: null,
  triggerPayload: {},
  needsReview: false,
  deliveryFailed: false,
  createdAt: "2026-11-25T02:00:00.000Z",
  finishedAt: null,
  ...overrides,
});

describe("live-runs watcher diff and toasts", () => {
  const t = (source: string, values?: Record<string, string | number>) => translate("en", source, values);

  it("records baseline without emitting notifications on initial load", () => {
    const first = diffLiveRuns(null, [makeRun({ state: "succeeded" })]);
    expect(first.changes).toEqual([]);
    expect(first.next.size).toBe(1);
  });

  it("emits started then updates the same toast id when the live run succeeds", () => {
    let prev: Map<string, LiveRunSnapshot> | null = diffLiveRuns(null, []).next;
    const running = makeRun({ state: "running" });
    const step1 = diffLiveRuns(prev, [running]);
    expect(step1.changes).toHaveLength(1);
    expect(step1.changes[0]!.kind).toBe("started");
    const startedToast = liveRunToast(step1.changes[0]!, t);
    expect(startedToast).toMatchObject({
      id: `live-run-${running.id}`,
      tone: "info",
      actionHref: `#/runs/${running.id}`,
      actionLabel: "View log",
    });
    expect(startedToast.message).toContain("is running");

    prev = step1.next;
    const finished = makeRun({ state: "succeeded", finishedAt: "2026-11-25T02:00:01.000Z" });
    const step2 = diffLiveRuns(prev, [finished]);
    expect(step2.changes).toHaveLength(1);
    expect(step2.changes[0]!.kind).toBe("finished");
    const doneToast = liveRunToast(step2.changes[0]!, t);
    expect(doneToast).toMatchObject({
      id: `live-run-${running.id}`,
      tone: "success",
      actionHref: `#/runs/${running.id}`,
    });
    expect(doneToast.message).toContain("ran and succeeded");
  });

  it("emits finished right away for fast runs and flags delivery failures and reviews", () => {
    const base = diffLiveRuns(null, []).next;
    const fast = makeRun({ id: "33333333-3333-3333-3333-333333333333", state: "succeeded" });
    const res = diffLiveRuns(base, [fast]);
    expect(res.changes.map((c) => c.kind)).toEqual(["finished"]);
    expect(liveRunToast(res.changes[0]!, t).tone).toBe("success");

    const delivErr = makeRun({ id: "44444444-4444-4444-4444-444444444444", state: "succeeded", deliveryFailed: true });
    const resErr = diffLiveRuns(res.next, [delivErr, fast]);
    expect(resErr.changes).toHaveLength(1);
    expect(liveRunToast(resErr.changes[0]!, t)).toMatchObject({ tone: "error", message: "Log GCash receipts from Telegram failed" });

    const rev = makeRun({ id: "55555555-5555-5555-5555-555555555555", state: "needs_review", needsReview: true });
    const resRev = diffLiveRuns(resErr.next, [rev, delivErr, fast]);
    expect(liveRunToast(resRev.changes[0]!, t)).toMatchObject({ tone: "warn", message: "Log GCash receipts from Telegram needs your review" });
  });
});
