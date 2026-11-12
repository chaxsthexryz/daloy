export type Change =
  | { path: string; kind: "added"; after: unknown }
  | { path: string; kind: "removed"; before: unknown }
  | { path: string; kind: "changed"; before: unknown; after: unknown };

type Obj = Record<string, unknown>;
type WithId = Obj & { id: string };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const shape = (v: unknown) => (Array.isArray(v) ? "array" : isObj(v) ? "object" : "scalar");
const hasId = (v: unknown): v is WithId => isObj(v) && typeof v.id === "string";
const key = (path: string, k: string) => (path ? `${path}.${k}` : k);

/**
 * Lists the differences between two JSON values as paths, in the order a reader meets them.
 * Arrays whose items all have a string id (workflow steps) are matched by id, others by index.
 */
export function jsonDiff(before: unknown, after: unknown, path = ""): Change[] {
  if (shape(before) !== shape(after)) return [{ path, kind: "changed", before, after }];

  if (Array.isArray(before) && Array.isArray(after)) {
    const items: unknown[] = [...before, ...after];
    if (items.length > 0 && items.every(hasId)) {
      const a = new Map((before as WithId[]).map((s) => [s.id, s]));
      const b = new Map((after as WithId[]).map((s) => [s.id, s]));
      return [
        ...[...a].flatMap(([id, s]): Change[] => (b.has(id) ? jsonDiff(s, b.get(id), `${path}[${id}]`) : [{ path: `${path}[${id}]`, kind: "removed", before: s }])),
        ...[...b].filter(([id]) => !a.has(id)).map(([id, s]): Change => ({ path: `${path}[${id}]`, kind: "added", after: s })),
      ];
    }
    return Array.from({ length: Math.max(before.length, after.length) }, (_, i): Change[] => {
      const p = `${path}[${i}]`;
      if (i >= after.length) return [{ path: p, kind: "removed", before: before[i] }];
      if (i >= before.length) return [{ path: p, kind: "added", after: after[i] }];
      return jsonDiff(before[i], after[i], p);
    }).flat();
  }

  if (isObj(before) && isObj(after)) {
    return [
      ...Object.keys(before).flatMap((k): Change[] => (k in after ? jsonDiff(before[k], after[k], key(path, k)) : [{ path: key(path, k), kind: "removed", before: before[k] }])),
      ...Object.keys(after)
        .filter((k) => !(k in before))
        .map((k): Change => ({ path: key(path, k), kind: "added", after: after[k] })),
    ];
  }

  return before === after ? [] : [{ path, kind: "changed", before, after }];
}
