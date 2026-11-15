import { definitionSchema, lintDefinition, type FormField, type Step, type Trigger } from "@daloy/engine";
import { Background, Controls, Handle, Position, ReactFlow, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { useEffect, useId, useMemo, useState } from "react";
import { AskAi } from "./AiDraft";
import { api, type Version, type Workflow } from "./api";
import { RunResult, useRun } from "./Runs";
import { ADDABLE, addStep, blankDraft, removeStep, toFlow, type AddableType, type Draft, type StepNodeData } from "./lib/graph";
import { SchemaForm, type JsonSchema } from "./SchemaForm";

type Catalog = { schemas: Record<string, JsonSchema>; branches: Record<string, string[]> };
type Loaded = Workflow & { trigger: { id: string; type: string; webhookPath: string | null } | null; live: Version | null; latest: Version | null };

const TYPE_NAMES: Record<string, string> = { condition: "Condition", http: "HTTP request", email: "Send email", delay: "Delay", ai: "AI task", approval: "Approval", sheets: "Add to Google Sheets", slack: "Post to Slack", outlook: "Send from Outlook", teams: "Post to Teams" };

function summary(step: Step): string {
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

function TriggerNode({ data }: NodeProps<Node<StepNodeData, "trigger">>) {
  return (
    <div className="node trigger-node">
      <span className="node-type">Trigger</span>
      <span className="node-title">{data.trigger!.type}</span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

function StepNode({ data }: NodeProps<Node<StepNodeData, "step">>) {
  const step = data.step!;
  return (
    <div className="node">
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="node-type">{TYPE_NAMES[step.type]}</span>
      <span className="node-title">{step.id}</span>
      <span className="node-summary">{summary(step)}</span>
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

const nodeTypes = { trigger: TriggerNode, step: StepNode };

// Tomorrow at 10:00 in the field's own zone, which is on any slot grid that divides the hours evenly.
const tomorrowAtTen = () => `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T10:00`;

function samplePayload(trigger: Trigger, resourceId = "a resource id from the Resources page"): string {
  if (trigger.type !== "form") return "{}";
  const sample = Object.fromEntries(
    trigger.config.fields.map((f) => [f.name, f.type === "number" ? 1 : f.type === "email" ? "ana@example.com" : f.type === "datetime" ? tomorrowAtTen() : f.type === "resource" ? resourceId : `Sample ${f.label.toLowerCase()}`]),
  );
  return JSON.stringify(sample, null, 2);
}

export function Editor({ id }: { id: string }) {
  const [wf, setWf] = useState<Loaded | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [firstResource, setFirstResource] = useState<string | undefined>();
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [payload, setPayload] = useState("{}");
  const [mode, setMode] = useState<"mock" | "ai" | "live">("mock");
  // stepId -> a test choice as JSON text ("" = the default outcome), so a <select> can hold it.
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [runId, setRunId] = useState<string | null>(null);
  const run = useRun(runId);

  const reload = async () => {
    const w = await api<Loaded>("GET", `/workflows/${id}`);
    setWf(w);
    return w;
  };
  useEffect(() => {
    void Promise.all([reload(), api<Catalog>("GET", "/step-schemas"), api<{ id: string; active: boolean }[]>("GET", "/resources").catch(() => [])])
      .then(([w, c, r]) => {
        const d = (w.latest?.definition as Draft | undefined) ?? blankDraft();
        setDraft(d);
        setFirstResource(r.find((x) => x.active)?.id);
        setPayload(samplePayload(d.trigger, r.find((x) => x.active)?.id));
        setCatalog(c);
      })
      .catch((e: Error) => setMessage({ kind: "error", text: e.message }));
  }, [id]);

  const update = (next: Draft) => {
    setDraft(next);
    setDirty(true);
  };
  const flow = useMemo(() => toFlow(draft, selected), [draft, selected]);
  // Advice only (decision 0033): a draft that does not parse yet is a work in progress, so it gets no checks.
  const warnings = useMemo(() => {
    const parsed = definitionSchema.safeParse(draft);
    return parsed.success ? lintDefinition(parsed.data) : [];
  }, [draft]);
  const nodes = flow.nodes.map((n) => (measured[n.id] ? { ...n, measured: measured[n.id] } : n));

  const onNodesChange = (changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === "dimensions" && c.dimensions) setMeasured((m) => ({ ...m, [c.id]: c.dimensions! }));
      if (c.type === "select" && c.selected) setSelected(c.id);
      if (c.type === "remove" && c.id !== "trigger") {
        update(removeStep(draft, c.id));
        setSelected(null);
      }
    }
  };

  const act = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ kind: "ok", text });
    } catch (e) {
      setMessage({ kind: "error", text: `${label} failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };
  const save = (publish: boolean) =>
    act(publish ? "Publish" : "Save", async () => {
      const v = await api<{ version: number }>("POST", `/workflows/${id}/versions`, { definition: draft, publish });
      setDirty(false);
      await reload();
      return publish ? `Version ${v.version} is live.` : `Saved as version ${v.version}.`;
    });
  const parsedPayload = () => {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      throw new Error("the sample data is not valid JSON");
    }
  };
  const testRun = () =>
    act("Test run", async () => {
      const r = await api<{ id: string; duplicate?: boolean; mode?: string }>("POST", `/workflows/${id}/test-runs`, {
        definition: draft,
        payload: parsedPayload(),
        mode,
        choices: mode === "live" ? {} : Object.fromEntries(draft.steps.flatMap((s) => (choices[s.id] ? [[s.id, JSON.parse(choices[s.id]!) as unknown]] : []))),
      });
      setDirty(false);
      setRunId(r.id);
      await reload();
      // act() shows a returned string as the result message.
      if (r.duplicate) return `This event key already ran, so nothing ran now. Showing the earlier ${{ mock: "mocked", ai: "real AI only", live: "live" }[r.mode ?? "mock"]} test run; change the event id to test again.`;
    });
  const runLive = () =>
    act("Run", async () => {
      const r = await api<{ id: string }>("POST", `/workflows/${id}/runs`, { payload: parsedPayload() });
      setRunId(r.id);
    });

  if (!wf || !catalog) return <main className="page">{message ? <p role="alert">{message.text}</p> : <p>Loading…</p>}</main>;

  const step = draft.steps.find((s) => s.id === selected);
  const status = dirty ? "Unsaved changes" : wf.latest ? `Version ${wf.latest.version}${wf.latest.published ? " (live)" : ", draft"}` : "Not saved yet";

  return (
    <div className="editor">
      <header className="toolbar">
        <a href="#/">Workflows</a>
        <h1>{wf.name}</h1>
        <a href={`#/w/${id}/runs`}>Runs</a>
        <a href={`#/w/${id}/versions`}>Versions</a>
        <span className="muted status" aria-live="polite">
          {status}
          {wf.live && !wf.latest?.published && ` · version ${wf.live.version} is live`}
        </span>
        <div className="actions">
          <button type="button" onClick={() => save(false)} disabled={busy || draft.steps.length === 0}>
            Save
          </button>
          <button type="button" className="primary" onClick={() => save(true)} disabled={busy || draft.steps.length === 0}>
            Publish
          </button>
        </div>
      </header>
      <main className="workspace">
        <section className="canvas" aria-label="Workflow diagram. Tab to a step and press Enter to select it, Delete to remove it.">
          <ReactFlow
            nodes={nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onPaneClick={() => setSelected(null)}
            nodesDraggable={false}
            nodesConnectable={false}
            deleteKeyCode="Delete"
            colorMode="system"
            fitView
            fitViewOptions={{ maxZoom: 1 }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </section>
        <aside className="panel">
          {message && (
            <p role={message.kind === "error" ? "alert" : "status"} className={`message ${message.kind}`}>
              {message.text}
            </p>
          )}
          {warnings.length > 0 && (
            <section aria-labelledby="checks-heading">
              <h2 id="checks-heading">Check before publishing</h2>
              <ul>
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </section>
          )}
          <AskAi
            workflowId={id}
            draft={draft}
            onApply={(d) => {
              update(d);
              setSelected(null);
              setPayload(samplePayload(d.trigger, firstResource));
            }}
          />
          <nav aria-label="Steps">
            <h2>Steps</h2>
            <ol className="outline">
              <li>
                <button type="button" aria-pressed={selected === "trigger"} onClick={() => setSelected("trigger")}>
                  Trigger: {draft.trigger.type}
                </button>
              </li>
              {draft.steps.map((s) => (
                <li key={s.id}>
                  <button type="button" aria-pressed={selected === s.id} onClick={() => setSelected(s.id)}>
                    {s.id} <span className="muted">{TYPE_NAMES[s.type]}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <AddStep
            draft={draft}
            after={step}
            branches={step ? catalog.branches[step.type] : undefined}
            onAdd={(type, on) => {
              const r = addStep(draft, type, step ? { id: step.id, on } : undefined);
              update(r.draft);
              setSelected(r.id);
            }}
          />
          {selected === "trigger" && <TriggerPanel trigger={draft.trigger} wf={wf} onChange={(trigger) => update({ ...draft, trigger })} />}
          {step && (
            <section aria-labelledby="step-heading">
              <h2 id="step-heading">
                {TYPE_NAMES[step.type]}: {step.id}
              </h2>
              <p className="muted hint">
                Use {"{{trigger.field}}"}, {"{{steps.step_id.output.field}}"} and {"{{secrets.name}}"} in text fields.
              </p>
              <SchemaForm
                key={step.id}
                schema={catalog.schemas[step.type]!}
                value={step.config as Record<string, unknown>}
                onChange={(config) => update({ ...draft, steps: draft.steps.map((s) => (s.id === step.id ? ({ ...s, config } as Step) : s)) })}
              />
              <button
                type="button"
                className="danger"
                onClick={() => {
                  update(removeStep(draft, step.id));
                  setSelected(null);
                }}
              >
                Delete step
              </button>
            </section>
          )}
          <section aria-labelledby="run-heading">
            <h2 id="run-heading">Run</h2>
            <div className="field">
              <label htmlFor="payload">Sample trigger data (JSON)</label>
              <textarea id="payload" rows={5} value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} />
            </div>
            <div className="field">
              <label htmlFor="test-mode">Test calls</label>
              <select id="test-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="mock">Mocked: nothing is sent and no model is called</option>
                <option value="ai">Real AI only: the model is called, everything else is mocked</option>
                <option value="live">Live: real HTTP, email, AI, approval emails and connected apps</option>
              </select>
            </div>
            {mode !== "live" && <TestChoices steps={draft.steps} choices={choices} onChange={setChoices} />}
            <div className="actions">
              <button type="button" onClick={testRun} disabled={busy || draft.steps.length === 0}>
                Test run draft
              </button>
              <button type="button" onClick={runLive} disabled={busy || !wf.live}>
                Run live version
              </button>
            </div>
            {run && (
              <>
                <RunResult run={run} />
                <p>
                  <a href={`#/runs/${run.id}`}>Open this run in the run history</a>
                </p>
              </>
            )}
          </section>
        </aside>
      </main>
    </div>
  );
}

function AddStep({ draft, after, branches, onAdd }: { draft: Draft; after?: Step; branches?: string[]; onAdd: (type: AddableType, on?: string) => void }) {
  const [type, setType] = useState<AddableType>("http");
  const [on, setOn] = useState("");
  const id = useId();
  const where = after ? `after ${after.id}` : draft.steps.length ? "at the start" : "as the first step";
  return (
    <div className="add-step">
      <div className="field">
        <label htmlFor={`${id}-type`}>Add a step {where}</label>
        <div className="row">
          <select id={`${id}-type`} value={type} onChange={(e) => setType(e.target.value as AddableType)}>
            {ADDABLE.map((t) => (
              <option key={t} value={t}>
                {TYPE_NAMES[t]}
              </option>
            ))}
          </select>
          {branches && (
            <select aria-label="Branch" value={on} onChange={(e) => setOn(e.target.value)}>
              <option value="">next free branch</option>
              {branches.map((b) => (
                <option key={b} value={b}>
                  on {b}
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={() => onAdd(type, branches && on ? on : undefined)}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

const TRIGGER_DEFAULTS: Record<Trigger["type"], Trigger> = {
  manual: { type: "manual", config: {} },
  webhook: { type: "webhook", config: {} },
  schedule: { type: "schedule", config: { cron: "0 9 * * 1" } },
  form: { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }] } },
};

function TriggerPanel({ trigger, wf, onChange }: { trigger: Trigger; wf: Loaded; onChange: (t: Trigger) => void }) {
  const id = useId();
  const published = wf.trigger && wf.live && wf.trigger.type === trigger.type ? wf.trigger : null;
  const fields = trigger.type === "form" ? trigger.config.fields : [];
  const setFields = (next: FormField[]) => onChange({ type: "form", config: { fields: next } });
  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Trigger</h2>
      <div className="field">
        <label htmlFor={`${id}-type`}>Starts when</label>
        <select id={`${id}-type`} value={trigger.type} onChange={(e) => onChange(TRIGGER_DEFAULTS[e.target.value as Trigger["type"]])}>
          <option value="manual">Started by hand</option>
          <option value="webhook">A webhook is called</option>
          <option value="schedule">On a schedule</option>
          <option value="form">A form is submitted</option>
        </select>
      </div>
      {trigger.type === "schedule" && (
        <div className="field">
          <label htmlFor={`${id}-cron`}>Cron expression (UTC)</label>
          <input id={`${id}-cron`} value={trigger.config.cron} onChange={(e) => onChange({ type: "schedule", config: { cron: e.target.value } })} />
        </div>
      )}
      {trigger.type === "webhook" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-hmac`}>
              Signing secret name <span className="muted">(optional)</span>
            </label>
            <input id={`${id}-hmac`} value={trigger.config.hmacSecret ?? ""} onChange={(e) => onChange({ type: "webhook", config: { ...trigger.config, hmacSecret: e.target.value || undefined } })} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-event-key`}>
              Event key <span className="muted">(optional, e.g. {"{{trigger.event_id}}"}: a repeated event starts no second run)</span>
            </label>
            <input id={`${id}-event-key`} value={trigger.config.eventKey ?? ""} onChange={(e) => onChange({ type: "webhook", config: { ...trigger.config, eventKey: e.target.value || undefined } })} />
          </div>
        </>
      )}
      {trigger.type === "form" && (
        <fieldset>
          <legend>Form fields</legend>
          {fields.map((f, i) => {
            const set = (patch: Partial<FormField>) => setFields(fields.map((g, j) => (j === i ? { ...g, ...patch } : g)));
            return (
              <div className="row" key={i}>
                <input aria-label={`Field ${i + 1} name`} value={f.name} onChange={(e) => set({ name: e.target.value })} />
                <input aria-label={`Field ${i + 1} label`} value={f.label} onChange={(e) => set({ label: e.target.value })} />
                {/* Number limits and datetime zones only exist on their own types, so changing the type drops them. */}
                <select
                  aria-label={`Field ${i + 1} type`}
                  value={f.type}
                  onChange={(e) => {
                    const type = e.target.value as FormField["type"];
                    set({ type, min: undefined, max: undefined, integer: undefined, slotMinutes: undefined, timezone: type === "datetime" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined });
                  }}
                >
                  {["text", "email", "textarea", "number", "datetime", "resource"].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <label className="check">
                  <input type="checkbox" checked={f.required} onChange={(e) => set({ required: e.target.checked })} /> required
                </label>
                {f.type === "number" && (
                  <>
                    <input aria-label={`Field ${i + 1} minimum`} type="number" step="any" placeholder="min" value={f.min ?? ""} onChange={(e) => set({ min: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    <input aria-label={`Field ${i + 1} maximum`} type="number" step="any" placeholder="max" value={f.max ?? ""} onChange={(e) => set({ max: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    <label className="check">
                      <input type="checkbox" checked={f.integer ?? false} onChange={(e) => set({ integer: e.target.checked || undefined })} /> whole number
                    </label>
                  </>
                )}
                {f.type === "datetime" && (
                  <>
                    <input aria-label={`Field ${i + 1} timezone`} placeholder="Asia/Manila" value={f.timezone ?? ""} onChange={(e) => set({ timezone: e.target.value })} />
                    <input aria-label={`Field ${i + 1} slot minutes`} type="number" min={1} max={1440} step={1} placeholder="slot minutes" value={f.slotMinutes ?? ""} onChange={(e) => set({ slotMinutes: e.target.value === "" ? undefined : Number(e.target.value) })} />
                  </>
                )}
                {f.type === "resource" && <span className="muted">a resource from the Resources page</span>}
                <button type="button" className="quiet" onClick={() => setFields(fields.filter((_, j) => j !== i))} disabled={fields.length === 1}>
                  Remove
                </button>
              </div>
            );
          })}
          <button type="button" className="quiet" onClick={() => setFields([...fields, { name: `field_${fields.length + 1}`, label: "New field", type: "text", required: false }])}>
            Add field
          </button>
        </fieldset>
      )}
      {published?.webhookPath && (
        <p className="muted hint">
          Webhook URL: <code>{`${location.origin}/hooks/${published.webhookPath}`}</code>
        </p>
      )}
      {published && trigger.type === "form" && (
        <p className="muted hint">
          Public form: <a href={`/forms/${published.id}`}>{`${location.origin}/forms/${published.id}`}</a>
        </p>
      )}
    </section>
  );
}

const OUTSIDE = new Set(["http", "email", "approval", "sheets", "slack", "outlook", "teams"]);

/** Per-step outcomes for a mocked or AI-only test run: a classify label, an approval decision, or a failure. */
function TestChoices({ steps, choices, onChange }: { steps: Step[]; choices: Record<string, string>; onChange: (c: Record<string, string>) => void }) {
  const options = (s: Step): [string, string][] => [
    ...(s.type === "ai" && s.config.task === "classify" ? Object.keys(s.config.labels ?? {}).map((l): [string, string] => [JSON.stringify({ label: l }), `label ${l}`]) : []),
    ...(s.type === "approval" ? ["approved", "rejected", "timeout"].map((d): [string, string] => [JSON.stringify({ decision: d }), d]) : []),
    ...(OUTSIDE.has(s.type) ? (["retryable", "permanent"] as const).map((f): [string, string] => [JSON.stringify({ fail: f }), `fail (${f})`]) : []),
  ];
  const choosable = steps.filter((s) => options(s).length > 0);
  if (choosable.length === 0) return null;
  return (
    <fieldset>
      <legend>Test outcomes</legend>
      {choosable.map((s) => (
        <div className="row" key={s.id}>
          <label htmlFor={`choice-${s.id}`}>{s.id}</label>
          <select id={`choice-${s.id}`} value={choices[s.id] ?? ""} onChange={(e) => onChange({ ...choices, [s.id]: e.target.value })}>
            <option value="">{s.type === "approval" ? "approved (default)" : s.type === "ai" ? "model or mock (default)" : "succeeds (default)"}</option>
            {options(s).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
      ))}
    </fieldset>
  );
}
