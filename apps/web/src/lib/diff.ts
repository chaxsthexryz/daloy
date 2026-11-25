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

import { conditionOpLabel, formatDuration, stepLabel, triggerLabel, type Step, type Trigger, type WorkflowDefinition } from "@daloy/engine";
import { translate, type Language } from "./locale";

export function canRollbackVersion(v: { version: number; latestVersion?: number; liveVersion?: number; published: boolean }): boolean {
  return v.published && v.version !== v.liveVersion && v.version !== v.latestVersion;
}

export type DescribedChange = {
  headline: string;
  beforeText: string;
  afterText: string;
  detailPath: string;
};

const showRaw = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));

function asDef(v: unknown): Partial<WorkflowDefinition> | null {
  return v && typeof v === "object" ? (v as Partial<WorkflowDefinition>) : null;
}

export function describeChange(c: Change, before: unknown, after: unknown, language: Language): DescribedChange {
  const t = (source: string) => translate(language, source);
  const bDef = asDef(before);
  const aDef = asDef(after);
  const cBefore = c.kind === "added" ? undefined : c.before;
  const cAfter = c.kind === "removed" ? undefined : c.after;
  const findStep = (id: string): Step | undefined => {
    const raw = cAfter ?? cBefore;
    return (
      aDef?.steps?.find((s) => s.id === id) ??
      bDef?.steps?.find((s) => s.id === id) ??
      (raw && typeof raw === "object" && "type" in (raw as Record<string, unknown>) ? (raw as Step) : undefined)
    );
  };

  const onErrorText = (v: unknown) => {
    if (v === "skip") return t("Skip and carry on");
    if (v === "failed_edge") return t("Take the failed path");
    if (v === "stop" || v === undefined || v === null) return t("Stop the run");
    return showRaw(v);
  };

  const stepMatch = /^steps\[([^\]]+)\](?:\.(.+))?$/.exec(c.path);
  if (stepMatch) {
    const [, stepId = "", sub] = stepMatch;
    const step = findStep(stepId);
    const stepTitle = step ? stepLabel(step.type, language) : stepId;
    if (!sub) {
      return {
        headline: stepTitle,
        beforeText: c.kind === "added" ? "" : stepTitle,
        afterText: c.kind === "removed" ? "" : stepTitle,
        detailPath: c.path,
      };
    }
    const fieldNames: Record<string, string> = {
      "config.condition.op": t("Operator"),
      "config.condition.left": t("Value"),
      "config.condition.right": t("Compare with"),
      "config.seconds": t("Wait"),
      "config.timeoutSeconds": t("Timeout"),
      "config.offsetSeconds": t("Offset"),
      onError: t("When a step fails"),
      disabled: t("Status"),
      note: t("Note"),
      "config.message": t("Message"),
      "config.text": t("Message"),
      "config.subject": t("Subject"),
      "config.to": t("Recipient"),
    };
    const field = fieldNames[sub] ?? sub.replace(/^config\./, "").replace(/[._]/g, " ");
    const formatVal = (v: unknown): string => {
      if (v === undefined) return "";
      if (sub === "config.condition.op") return conditionOpLabel(String(v), language);
      if (sub === "config.seconds" || sub === "config.timeoutSeconds" || sub === "config.offsetSeconds") {
        return typeof v === "number" && Number.isFinite(v) ? formatDuration(Math.abs(v), language) : showRaw(v);
      }
      if (sub === "onError") return onErrorText(v);
      if (sub === "disabled") return v ? t("Turned off") : t("Enabled");
      return showRaw(v);
    };
    return {
      headline: `${stepTitle} · ${field}`,
      beforeText: c.kind === "added" ? "" : formatVal(c.before),
      afterText: c.kind === "removed" ? "" : formatVal(c.after),
      detailPath: c.path,
    };
  }

  const triggerMatch = /^trigger(?:\.(.+))?$/.exec(c.path);
  if (triggerMatch) {
    const sub = triggerMatch[1];
    const fmtTrigger = (v: unknown) => {
      if (sub === "type" && typeof v === "string") return triggerLabel(v as Trigger["type"], language);
      if (v && typeof v === "object" && "type" in (v as Record<string, unknown>)) return triggerLabel((v as Trigger).type, language);
      return showRaw(v);
    };
    return {
      headline: sub ? `${t("Trigger")} · ${sub.replace(/^config\./, "")}` : t("Trigger"),
      beforeText: c.kind === "added" ? "" : fmtTrigger(c.before),
      afterText: c.kind === "removed" ? "" : fmtTrigger(c.after),
      detailPath: c.path,
    };
  }

  const edgeMatch = /^edges(?:\[(\d+)\])?(?:\.(.+))?$/.exec(c.path);
  if (edgeMatch) {
    const [, idx, sub] = edgeMatch;
    const base = idx !== undefined ? `${t("Connection")} ${Number(idx) + 1}` : t("Connection");
    return {
      headline: sub ? `${base} · ${sub}` : base,
      beforeText: c.kind === "added" ? "" : showRaw(c.before),
      afterText: c.kind === "removed" ? "" : showRaw(c.after),
      detailPath: c.path,
    };
  }

  return {
    headline: c.path || t("(whole definition)"),
    beforeText: c.kind === "added" ? "" : showRaw(c.before),
    afterText: c.kind === "removed" ? "" : showRaw(c.after),
    detailPath: c.path,
  };
}
