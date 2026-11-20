import { translate, type Language } from "./lib/locale";
import { useLanguage } from "./Language";
import type { Step } from "@daloy/engine";
import { BaseEdge, Background, Controls, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, Handle, Panel, Position, ReactFlow, useReactFlow, useViewport, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { toFlow, type Draft, type RunEdgeData, type StepNodeData } from "./lib/graph";
import { runFlow, STATUS, type FlowRun } from "./lib/run-flow";

export const TYPE_NAMES: Record<string, string> = { condition: "Condition", http: "HTTP request", email: "Send email", delay: "Delay", ai: "AI task", approval: "Approval", sheets: "Add to Google Sheets", drive: "Save files to Google Drive", slack: "Post to Slack", outlook: "Send from Outlook", teams: "Post to Teams", telegram: "Send to Telegram", sms: "Send SMS", calendar: "Add to Google Calendar", paymongo_link: "Create payment link", payment_status: "Check payment", airtable: "Add to Airtable", notion: "Add to Notion", trello: "Add to Trello", booking: "Booking", meta_reply: "Reply on Messenger or Instagram" };

export function summary(step: Step, language: Language = "en"): string {
  const t = (source: string, values?: Record<string, string | number>) => translate(language, source, values);
  switch (step.type) {
    case "condition":
      return `${step.config.condition.left} ${step.config.condition.op} ${step.config.condition.right ?? ""}`;
    case "http":
      return `${step.config.method} ${step.config.url}`;
    case "email":
    case "outlook":
    case "sms":
      return t("to {recipient}", { recipient: String(step.config.to) });
    case "delay": {
      const { seconds, until, offsetSeconds } = step.config;
      if (until === undefined) return `${seconds} s`;
      return offsetSeconds ? t("until {time} {sign} {seconds} s", { time: until, sign: t(offsetSeconds < 0 ? "minus" : "plus"), seconds: Math.abs(offsetSeconds) }) : t("until {time}", { time: until });
    }
    case "ai":
      return step.config.task === "classify" ? t("classify: {labels}", { labels: Object.keys(step.config.labels ?? {}).join(", ") }) : t(step.config.task);
    case "approval":
      return t("ask {person}", { person: String(step.config.approver ?? step.config.to) });
    case "sheets":
      return t("{count} columns, reference first", { count: step.config.columns.length + 2 });
    case "drive":
      return "files from the form";
    case "slack":
    case "teams":
    case "telegram":
    case "meta_reply":
      return step.config.text.slice(0, 60);
    case "calendar":
      return step.config.title.slice(0, 60);
    case "paymongo_link":
      return t("{amount} pesos, {reference}", { amount: String(step.config.amount), reference: String(step.config.reference) });
    case "payment_status":
      return step.config.link;
    case "airtable":
      return Object.keys(step.config.fields).join(", ");
    case "notion":
      return step.config.title.slice(0, 60);
    case "trello":
      return step.config.name.slice(0, 60);
    case "booking":
      return step.config.action === "create" ? t("book {resource} at {start}, {minutes} min", { resource: String(step.config.resource), start: String(step.config.start), minutes: String(step.config.minutes) }) : t("{action} {booking}", { action: t(step.config.action), booking: String(step.config.booking) });
  }
}

/** The state in words and a symbol under the title, shown whenever a run is drawn. Colour only adds to it. */
function Status({ status }: { status: StepNodeData["status"] }) {
  const { t } = useLanguage();
  if (!status) return null;
  const s = STATUS[status];
  return (
    <span className="node-status">
      <span aria-hidden="true">{s.symbol}</span> {t(s.label)}
    </span>
  );
}

const nodeClass = (base: string, status: StepNodeData["status"]) => (status ? `${base} run-${status}` : base);

function TriggerNode({ data }: NodeProps<Node<StepNodeData, "trigger">>) {
  const { t } = useLanguage();
  return (
    <div className={nodeClass("node trigger-node", data.status)}>
      <span className="node-type">{t("Trigger")}</span>
      <span className="node-title">{t(data.trigger!.type)}</span>
      <Status status={data.status} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

function StepNode({ data }: NodeProps<Node<StepNodeData, "step">>) {
  const { t, language } = useLanguage();
  const step = data.step!;
  return (
    <div className={nodeClass("node", data.status)}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="node-type">{t(TYPE_NAMES[step.type]!)}</span>
      <span className="node-title">{step.id}</span>
      <span className="node-summary">{summary(step, language)}</span>
      <Status status={data.status} />
      {data.branches ? (
        data.branches.map((b, i) => (
          <Handle key={b} id={b} type="source" position={Position.Bottom} isConnectable={false} style={{ left: `${((i + 1) / (data.branches!.length + 1)) * 100}%` }} />
        ))
      ) : (
        <Handle type="source" position={Position.Bottom} isConnectable={false} />
      )}
    </div>
  );
}

/** True when the visitor asked for less motion. SVG animateMotion ignores CSS media queries, so the edge asks here. */
function useReducedMotion() {
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const q = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** A normal edge that takes the run's state: solid green when taken, dashed when not, and a dot travelling along it while work flows in. */
function RunEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, data }: EdgeProps<Edge<RunEdgeData>>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const reduced = useReducedMotion();
  const state = data?.state ?? "idle";
  return (
    <>
      <BaseEdge id={id} path={path} label={label} labelX={labelX} labelY={labelY} className={`run-edge ${state}`} data-state={state} />
      {state === "flowing" && !reduced && (
        <circle r={4} className="run-dot">
          <animateMotion dur="1.2s" repeatCount="indefinite" path={path} calcMode="linear" />
        </circle>
      )}
    </>
  );
}

/** Editor node data: the shared node data plus the step's place in the list and an app it still needs. */
export type EditorNodeData = StepNodeData & { index?: number; needsApp?: string };

function EditorTriggerNode({ data }: NodeProps<Node<EditorNodeData, "trigger">>) {
  const { t } = useLanguage();
  return (
    <div className={nodeClass("node a7-node trigger-node", data.status)}>
      <span className="a7-node-row">
        <span className="a7-node-kicker a7-when">{t("When")}</span>
        <span className="a7-node-note">{t(data.trigger!.type)}</span>
      </span>
      <span className="node-title">{t("Trigger")}</span>
      <Status status={data.status} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

function EditorStepNode({ data }: NodeProps<Node<EditorNodeData, "step">>) {
  const { t, language } = useLanguage();
  const step = data.step!;
  return (
    <div className={nodeClass(`node a7-node${data.needsApp ? " a7-needs-app" : ""}`, data.status)}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="a7-node-row">
        <span className="a7-node-kicker">
          {data.index} · {t(TYPE_NAMES[step.type]!)}
        </span>
        {data.needsApp && <span className="a7-node-note a7-warn">{t("Not connected")}</span>}
      </span>
      <span className="node-title">{step.id}</span>
      <span className="node-summary">{summary(step, language)}</span>
      <Status status={data.status} />
      {data.branches ? (
        data.branches.map((b, i) => (
          <Handle key={b} id={b} type="source" position={Position.Bottom} isConnectable={false} style={{ left: `${((i + 1) / (data.branches!.length + 1)) * 100}%` }} />
        ))
      ) : (
        <Handle type="source" position={Position.Bottom} isConnectable={false} />
      )}
    </div>
  );
}

/** The editor's edge: square corners, the branch as a coloured pill, and the run state when a test run is drawn. */
function EditorEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, data }: EdgeProps<Edge<Partial<RunEdgeData> & { on?: string }>>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 0 });
  const reduced = useReducedMotion();
  const state = data?.state;
  return (
    <>
      <BaseEdge id={id} path={path} className={state ? `run-edge ${state}` : "a7-edge"} data-state={state} />
      {label && (
        <EdgeLabelRenderer>
          <span className="a7-branch nodrag nopan" data-branch={data?.on} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {label}
          </span>
        </EdgeLabelRenderer>
      )}
      {state === "flowing" && !reduced && (
        <circle r={4} className="run-dot">
          <animateMotion dur="1.2s" repeatCount="indefinite" path={path} calcMode="linear" />
        </circle>
      )}
    </>
  );
}

export const editorNodeTypes = { trigger: EditorTriggerNode, step: EditorStepNode };
export const editorEdgeTypes = { editor: EditorEdge };

/** Zoom out, the zoom level, zoom in and fit, in the canvas's bottom-left corner. */
export function ZoomBar() {
  const { t } = useLanguage();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <Panel position="bottom-left" className="a7-zoom">
      <button type="button" aria-label={t("Zoom Out")} onClick={() => void zoomOut()}>
        <span aria-hidden="true">−</span>
      </button>
      <span className="a7-zoom-level">{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label={t("Zoom In")} onClick={() => void zoomIn()}>
        <span aria-hidden="true">+</span>
      </button>
      <button type="button" className="a7-fit" onClick={() => void fitView({ maxZoom: 1 })}>
        {t("Fit")}
      </button>
    </Panel>
  );
}

/** React Flow supplies this wording itself, so it needs the workspace language too. */
export function flowAriaLabels(language: Language) {
  const t = (source: string) => translate(language, source);
  return {
    "node.a11yDescription.default": t("Press enter or space to select a node. Press delete to remove it and escape to cancel."),
    "node.a11yDescription.keyboardDisabled": t("Press enter or space to select a node. You can then use the arrow keys to move the node around. Press delete to remove it and escape to cancel."),
    "edge.a11yDescription.default": t("Press enter or space to select an edge. You can then press delete to remove it or escape to cancel."),
    "controls.ariaLabel": t("Control Panel"),
    "controls.zoomIn.ariaLabel": t("Zoom In"),
    "controls.zoomOut.ariaLabel": t("Zoom Out"),
    "controls.fitView.ariaLabel": t("Fit View"),
    "controls.interactive.ariaLabel": t("Toggle Interactivity"),
    "minimap.ariaLabel": t("Mini Map"),
    "handle.ariaLabel": t("Handle"),
  };
}

export const nodeTypes = { trigger: TriggerNode, step: StepNode };
export const edgeTypes = { run: RunEdge };

/**
 * The path one run took through its definition, read only. The run page uses it; polling comes from useRun. In the console
 * it follows the theme chosen in Settings (html data-theme); the light-only public demo fixes colorMode.
 */
export function RunFlow({ draft, run, colorMode }: { draft: Draft; run: FlowRun | null; colorMode?: "light" }) {
  const { language } = useLanguage();
  const flow = useMemo(() => toFlow(draft, null, runFlow(draft, run), language), [draft, run, language]);
  return (
    <div className="run-canvas">
      <ReactFlow
        ariaLabelConfig={flowAriaLabels(language)}
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        colorMode={colorMode ?? (document.documentElement.dataset.theme === "dark" ? "dark" : "light")}
        fitView
        fitViewOptions={{ maxZoom: 1 }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
