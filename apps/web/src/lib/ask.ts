export type AskRunInput = {
  id: string;
  reference: string | null;
  workflowName: string;
  state?: string;
  createdAt?: string;
};

export type AskRequestItem = {
  id: string;
  reference: string;
  workflowName: string;
  state: string;
  createdAt: string;
};

/** Keeps runs with non-empty references, deduplicated by reference (newest first), capped to `limit`. */
export function recentRequests(runs: readonly AskRunInput[], limit = 25): AskRequestItem[] {
  const seen = new Set<string>();
  const out: AskRequestItem[] = [];
  for (const r of runs) {
    const ref = r.reference?.trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push({
      id: r.id,
      reference: ref,
      workflowName: r.workflowName,
      state: r.state ?? "",
      createdAt: r.createdAt ?? "",
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Case-insensitive filter across request reference and automation name. */
export function filterRequests(list: readonly AskRequestItem[], query: string): AskRequestItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((r) => r.reference.toLowerCase().includes(q) || r.workflowName.toLowerCase().includes(q));
}
