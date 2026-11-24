import { FINISHED, type RunSummary } from "../api";
import type { ToastPayload } from "../Toast";

export const LIVE_RUN_EVENT = "kymavo:live-run";

export type LiveRunSnapshot = {
  state: string;
  needsReview: boolean;
  deliveryFailed: boolean;
};

export type LiveRunChange = {
  kind: "started" | "finished";
  run: RunSummary;
};

export const snapshotOf = (run: RunSummary): LiveRunSnapshot => ({
  state: run.state,
  needsReview: run.needsReview,
  deliveryFailed: Boolean(run.deliveryFailed),
});

export const isLiveRunFinished = (run: RunSummary): boolean =>
  FINISHED.has(run.state) ||
  run.state === "waiting" ||
  run.state === "needs_review" ||
  run.needsReview ||
  Boolean(run.deliveryFailed);

const sameSnapshot = (a: LiveRunSnapshot, b: LiveRunSnapshot): boolean =>
  a.state === b.state && a.needsReview === b.needsReview && a.deliveryFailed === b.deliveryFailed;

/**
 * Compares the latest live-run list against the previous poll snapshot so only newly started
 * or newly finished live runs trigger notifications and canvas updates (no baseline flood on load).
 */
export function diffLiveRuns(
  prev: Map<string, LiveRunSnapshot> | null,
  incoming: readonly RunSummary[],
): { next: Map<string, LiveRunSnapshot>; changes: LiveRunChange[] } {
  const next = new Map<string, LiveRunSnapshot>();
  for (const run of incoming) next.set(run.id, snapshotOf(run));
  if (prev) {
    for (const [id, snap] of prev) {
      if (!next.has(id) && next.size < 100) next.set(id, snap);
    }
  }
  if (prev === null) return { next, changes: [] };

  const changes: LiveRunChange[] = [];
  for (let i = incoming.length - 1; i >= 0; i--) {
    const run = incoming[i]!;
    const curr = snapshotOf(run);
    const old = prev.get(run.id);
    if (!old) {
      changes.push({ kind: isLiveRunFinished(run) ? "finished" : "started", run });
      continue;
    }
    if (sameSnapshot(old, curr)) continue;
    const wasFinished =
      FINISHED.has(old.state) || old.state === "waiting" || old.state === "needs_review" || old.needsReview || old.deliveryFailed;
    const nowFinished = isLiveRunFinished(run);
    if (nowFinished || !wasFinished) {
      changes.push({ kind: nowFinished ? "finished" : "started", run });
    }
  }
  return { next, changes };
}

export function liveRunToast(
  change: LiveRunChange,
  t: (source: string, values?: Record<string, string | number>) => string,
): ToastPayload {
  const { run } = change;
  const name = run.workflowName;
  const base = {
    id: `live-run-${run.id}`,
    actionLabel: t("View log"),
    actionHref: `#/runs/${run.id}`,
  };
  if (run.needsReview || run.state === "needs_review") {
    return { ...base, tone: "warn", message: t("{name} needs your review", { name }), durationMs: 6500 };
  }
  if (run.state === "failed" || run.deliveryFailed) {
    return { ...base, tone: "error", message: t("{name} failed", { name }), durationMs: 6500 };
  }
  if (run.state === "succeeded") {
    return { ...base, tone: "success", message: t("{name} ran and succeeded", { name }), durationMs: 6500 };
  }
  if (run.state === "waiting") {
    return { ...base, tone: "info", message: t("{name} is waiting", { name }), durationMs: 6500 };
  }
  if (run.state === "cancelled") {
    return { ...base, tone: "info", message: t("{name} stopped", { name }), durationMs: 6500 };
  }
  return { ...base, tone: "info", message: t("{name} is running…", { name }), durationMs: 8000 };
}
