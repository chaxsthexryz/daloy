/** Undo and redo for the editor: whole drafts in memory. `key` merges a run of edits to one field into one undo step. */
export type History<T> = { past: T[]; present: T; future: T[]; key?: string };

const LIMIT = 100;

export const startHistory = <T>(present: T): History<T> => ({ past: [], present, future: [] });

export function record<T>(h: History<T>, next: T, key?: string): History<T> {
  if (next === h.present) return h;
  if (key !== undefined && key === h.key) return { ...h, present: next, future: [] };
  return { past: [...h.past, h.present].slice(-LIMIT), present: next, future: [], key };
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) };
}
