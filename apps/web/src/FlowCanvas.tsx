import type { Step } from "@daloy/engine";
import { BaseEdge, Background, Controls, getBezierPath, Handle, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { toFlow, type Draft, type RunEdgeData, type StepNodeData } from "./lib/graph";
import { runFlow, STATUS, type FlowRun } from "./lib/run-flow";

export const TYPE_NAMES: Record<string, string> = { condition: "Condition", http: "HTTP request", email: "Send email", delay: "Delay", ai: "AI task", approval: "Approval", sheets: "Add to Google Sheets", slack: "Post to Slack", outlook: "Send from Outlook", teams: "Post to Teams" };

export function summary(step: Step): string {
  switch (step.type) {
    case "condition":
      return `${step.config.condition.left} ${step.config.condition.op} ${step.config.condition.right ?? ""}`;
    case "http":
      return `${step.config.method} ${step.config.url}`;
    case "email":
    case "outlook":
      return `to ${step.config.to}`;
    case "delay": {
      const { seconds, until, offsetSeconds } = step.config;
      if (until === undefined) return `${seconds} s`;
      return offsetSeconds ? `until ${until} ${offsetSeconds < 0 ? "minus" : "plus"} ${Math.abs(offsetSeconds)} s` : `until ${until}`;
    }
    case "ai":
      return step.config.task === "classify" ? `classify: ${Object.keys(step.config.labels ?? {}).join(", ")}` : step.config.task;
    case "approval":
      return `ask ${step.config.approver ?? step.config.to}`;
    case "sheets":
      return `${step.config.columns.length + 2} columns, reference first`;
    case "slack":
    case "teams":
      return step.config.text.slice(0, 60);
    case "booking":
      return step.config.action === "create" ? `book ${step.config.resource} at ${step.config.start}, ${step.config.minutes} min` : `${step.config.action} ${step.config.booking}`;
  }
}

/** The state in words and a symbol under the title, shown whenever a run is drawn. Colour only adds to it. */
function Status({ status }: { status: StepNodeData["status"] }) {
  if (!status) return null;
  const s = STATUS[status];
  return (
    <span className="node-status">
      <span aria-hidden="true">{s.symbol}</span> {s.label}
    </span>
  );
}

const nodeClass = (base: string, status: StepNodeData["status"]) => (status ? `${base} run-${status}` : base);

function TriggerNode({ data }: NodeProps<Node<StepNodeData, "trigger">>) {
  return (
    <div className={nodeClass("node trigger-node", data.status)}>
      <span className="node-type">Trigger</span>
      <span className="node-title">{data.trigger!.type}</span>
      <Status status={data.status} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

function StepNode({ data }: NodeProps<Node<StepNodeData, "step">>) {
  const step = data.step!;
  return (
    <div className={nodeClass("node", data.status)}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="node-type">{TYPE_NAMES[step.type]}</span>
      <span className="node-title">{step.id}</span>
      <span className="node-summary">{summary(step)}</span>
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

export const nodeTypes = { trigger: TriggerNode, step: StepNode };
export const edgeTypes = { run: RunEdge };

/**
 * The path one run took through its definition, read only. The run page uses it; polling comes from useRun. In the console
 * it follows the theme chosen in Settings (html data-theme); the light-only public demo fixes colorMode.
 */
export function RunFlow({ draft, run, colorMode }: { draft: Draft; run: FlowRun | null; colorMode?: "light" }) {
  const flow = useMemo(() => toFlow(draft, null, runFlow(draft, run)), [draft, run]);
  return (
    <div className="run-canvas">
      <ReactFlow
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
