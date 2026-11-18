import { useLanguage } from "./Language";
import { definitionSchema, lintDefinition, type FormField, type Step, type Trigger } from "@daloy/engine";
import { Background, Controls, ReactFlow, type NodeChange } from "@xyflow/react";
import { useEffect, useId, useMemo, useState } from "react";
import { AskAi } from "./AiDraft";
import { FormEmbed } from "./FormEmbed";
import { api, type Version, type Workflow } from "./api";
import { edgeTypes, flowAriaLabels, nodeTypes, TYPE_NAMES } from "./FlowCanvas";
import { RunResult, useRun } from "./Runs";
import { ADDABLE, addStep, blankDraft, removeStep, toFlow, type AddableType, type Draft } from "./lib/graph";
import { warningForLanguage } from "./lib/ai-build";
import { runFlow } from "./lib/run-flow";
import { AutomationTabs } from "./Nav";
import { SchemaForm, type JsonSchema } from "./SchemaForm";
import { EmailSource } from "./EmailSource";

type Catalog = { schemas: Record<string, JsonSchema>; branches: Record<string, string[]> };
type Loaded = Workflow & { trigger: { id: string; type: string; webhookPath: string | null } | null; live: Version | null; latest: Version | null };

// Tomorrow at 10:00 in the field's own zone, which is on any slot grid that divides the hours evenly.
const tomorrowAtTen = () => `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T10:00`;

function samplePayload(trigger: Trigger, resourceId = "a resource id from the Resources page"): string {
  if (trigger.type === "email") return JSON.stringify({ from: "ana@example.com", replyTo: "ana@example.com", to: ["inquiries@example.com"], subject: "Website inquiry", text: "I would like a quote.", messageId: "sample-inquiry@example.com", receivedAt: new Date().toISOString() }, null, 2);
  if (trigger.type !== "form") return "{}";
  // File fields are left out: a test run takes no files, and the server drops a value sent for one.
  const sample = Object.fromEntries(
    trigger.config.fields.filter((f) => f.type !== "file").map((f) => [f.name, f.type === "number" ? 1 : f.type === "email" ? "ana@example.com" : f.type === "datetime" ? tomorrowAtTen() : f.type === "resource" ? resourceId : `Sample ${f.label.toLowerCase()}`]),
  );
  return JSON.stringify(sample, null, 2);
}

// SchemaForm cannot render arrays, so the AI step's files are chosen with checkboxes below it.
const withoutFiles = (schema: JsonSchema): JsonSchema => ({ ...schema, properties: Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => k !== "files")) });

export function Editor({ id }: { id: string }) {
  const { t, language } = useLanguage();
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
  const { run } = useRun(runId);

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
  const flow = useMemo(() => toFlow(draft, selected, run ? runFlow(draft, run) : undefined, language), [draft, selected, run, language]);
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
      setMessage({ kind: "error", text: t("{action} failed: {error}", { action: t(label), error: (e as Error).message }) });
    } finally {
      setBusy(false);
    }
  };
  const save = (publish: boolean) =>
    act(publish ? "Publish" : "Save", async () => {
      const v = await api<{ version: number }>("POST", `/workflows/${id}/versions`, { definition: draft, publish });
      setDirty(false);
      await reload();
      return publish ? t("Version {version} is live.", { version: v.version }) : t("Saved as version {version}.", { version: v.version });
    });
  const parsedPayload = () => {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      throw new Error(t("the sample data is not valid JSON"));
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
      if (r.duplicate) return t("This event key already ran, so nothing ran now. Showing the earlier {mode} test run; change the event id to test again.", { mode: t({ mock: "mocked", ai: "real AI only", live: "live" }[r.mode ?? "mock"] ?? "mocked") });
    });
  const runLive = () =>
    window.confirm(t("Run the live version now? It sends real email and calls real services.")) &&
    act("Run", async () => {
      const r = await api<{ id: string }>("POST", `/workflows/${id}/runs`, { payload: parsedPayload() });
      setRunId(r.id);
    });

  if (!wf || !catalog) return <main className="page">{message ? <p role="alert">{message.text}</p> : <p>{t("Loading…")}</p>}</main>;

  const step = draft.steps.find((s) => s.id === selected);
  const status = dirty ? t("Unsaved changes") : wf.latest ? t("Version {version}{state}", { version: wf.latest.version, state: t(wf.latest.published ? " (live)" : ", draft") }) : t("Not saved yet");

  return (
    <div className="editor">
      <header className="toolbar">
        <a href="#/">{t("Automations")}</a>
        <h1>{wf.name}</h1>
        <AutomationTabs id={id} here="steps" overview={!!wf.setup && !!wf.live} />
        <a href={`#/w/${id}/versions`}>{t("Versions")}</a>
        <span className="muted status" aria-live="polite">
          {status}
          {wf.live && !wf.latest?.published && t(" · version {version} is live", { version: wf.live.version })}
        </span>
        <div className="actions">
          <button type="button" onClick={() => save(false)} disabled={busy || draft.steps.length === 0}>
            {t("Save")}
          </button>
          <button type="button" className="primary" onClick={() => window.confirm(t("Publish this version? It replaces the live version at once.")) && save(true)} disabled={busy || draft.steps.length === 0}>
            {t("Publish")}
          </button>
        </div>
      </header>
      <main className="workspace">
        <section className="canvas" aria-label={t("Workflow diagram. Tab to a step and press Enter to select it, Delete to remove it.")}>
          <ReactFlow
            ariaLabelConfig={flowAriaLabels(language)}
            nodes={nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onPaneClick={() => setSelected(null)}
            nodesDraggable={false}
            nodesConnectable={false}
            deleteKeyCode="Delete"
            colorMode={document.documentElement.dataset.theme === "dark" ? "dark" : "light"}
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
              <h2 id="checks-heading">{t("Check before publishing")}</h2>
              <ul>
                {warnings.map((w) => (
                  <li key={w}>{warningForLanguage(w, language)}</li>
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
          <nav aria-label={t("Steps")}>
            <h2>{t("Steps")}</h2>
            <ol className="outline">
              <li>
                <button type="button" aria-pressed={selected === "trigger"} onClick={() => setSelected("trigger")}>
                  {t("Trigger: {type}", { type: t(draft.trigger.type) })}
                </button>
              </li>
              {draft.steps.map((s) => (
                <li key={s.id}>
                  <button type="button" aria-pressed={selected === s.id} onClick={() => setSelected(s.id)}>
                    {s.id} <span className="muted">{t(TYPE_NAMES[s.type]!)}</span>
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
              const r = addStep(draft, type, step ? { id: step.id, on } : undefined, language);
              update(r.draft);
              setSelected(r.id);
            }}
          />
          {selected === "trigger" && <TriggerPanel trigger={draft.trigger} wf={wf} onChange={(trigger) => update({ ...draft, trigger })} />}
          {step && (
            <section aria-labelledby="step-heading">
              <h2 id="step-heading">
                {t(TYPE_NAMES[step.type]!)}: {step.id}
              </h2>
              <p className="muted hint">
                {t("Use {trigger}, {step} and {secret} in text fields.", { trigger: "{{trigger.field}}", step: "{{steps.step_id.output.field}}", secret: "{{secrets.name}}" })}
              </p>
              <SchemaForm
                key={step.id}
                schema={step.type === "ai" ? withoutFiles(catalog.schemas.ai!) : catalog.schemas[step.type]!}
                value={step.config as Record<string, unknown>}
                onChange={(config) => update({ ...draft, steps: draft.steps.map((s) => (s.id === step.id ? ({ ...s, config } as Step) : s)) })}
              />
              {step.type === "ai" && draft.trigger.type === "form" && draft.trigger.config.fields.some((f) => f.type === "file") && (
                <fieldset>
                  <legend>{t("Let the AI read these files")}</legend>
                  {draft.trigger.config.fields
                    .filter((f) => f.type === "file")
                    .map((f) => (
                      <label key={f.name} className="check">
                        <input
                          type="checkbox"
                          checked={(step.config as { files?: string[] }).files?.includes(f.name) ?? false}
                          onChange={(e) => {
                            const { files = [], ...rest } = step.config as { files?: string[] };
                            const next = e.target.checked ? [...files, f.name] : files.filter((n) => n !== f.name);
                            const config = next.length ? { ...rest, files: next } : rest;
                            update({ ...draft, steps: draft.steps.map((s) => (s.id === step.id ? ({ ...s, config } as Step) : s)) });
                          }}
                        />
                        {f.label}
                      </label>
                    ))}
                  <p className="muted hint">{t("Checked files are sent to the AI model you picked on the AI model page. Photos need Gemini, OpenAI or OpenRouter.")}</p>
                </fieldset>
              )}
              <button
                type="button"
                className="danger"
                onClick={() => {
                  update(removeStep(draft, step.id));
                  setSelected(null);
                }}
              >
                {t("Delete step")}
              </button>
            </section>
          )}
          <section aria-labelledby="run-heading">
            <h2 id="run-heading">{t("Run")}</h2>
            <div className="field">
              <label htmlFor="payload">{t("Sample trigger data (JSON)")}</label>
              <textarea id="payload" rows={5} value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} />
            </div>
            <div className="field">
              <label htmlFor="test-mode">{t("Test calls")}</label>
              <select id="test-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="mock">{t("Mocked: nothing is sent and no model is called")}</option>
                <option value="ai">{t("Real AI only: the model is called, everything else is mocked")}</option>
                <option value="live">{t("Live: real HTTP, email, AI, approval emails and connected apps")}</option>
              </select>
            </div>
            {mode !== "live" && <TestChoices steps={draft.steps} choices={choices} onChange={setChoices} />}
            <div className="actions">
              <button type="button" onClick={testRun} disabled={busy || draft.steps.length === 0}>
                {t("Test run draft")}
              </button>
              <button type="button" onClick={runLive} disabled={busy || !wf.live}>
                {t("Run live version")}
              </button>
            </div>
            {run && (
              <>
                <RunResult run={run} />
                <p>
                  <a href={`#/runs/${run.id}`}>{t("Open this run in the run history")}</a>
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
  const { t } = useLanguage();
  const [type, setType] = useState<AddableType>("http");
  const [on, setOn] = useState("");
  const id = useId();
  const where = after ? t("after {id}", { id: after.id }) : t(draft.steps.length ? "at the start" : "as the first step");
  return (
    <div className="add-step">
      <div className="field">
        <label htmlFor={`${id}-type`}>{t("Add a step {where}", { where })}</label>
        <div className="row">
          <select id={`${id}-type`} value={type} onChange={(e) => setType(e.target.value as AddableType)}>
            {ADDABLE.map((kind) => (
              <option key={kind} value={kind}>
                {t(TYPE_NAMES[kind]!)}
              </option>
            ))}
          </select>
          {branches && (
            <select aria-label={t("Branch")} value={on} onChange={(e) => setOn(e.target.value)}>
              <option value="">{t("next free branch")}</option>
              {branches.map((b) => (
                <option key={b} value={b}>
                  {t("on {branch}", { branch: t(b) })}
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={() => onAdd(type, branches && on ? on : undefined)}>
            {t("Add")}
          </button>
        </div>
      </div>
    </div>
  );
}

const TRIGGER_DEFAULTS: Record<Trigger["type"], Trigger> = {
  manual: { type: "manual", config: {} },
  email: { type: "email", config: {} },
  webhook: { type: "webhook", config: {} },
  schedule: { type: "schedule", config: { cron: "0 9 * * 1" } },
  form: { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }] } },
  payment: { type: "payment", config: { events: ["paid"] } },
};

function TriggerPanel({ trigger, wf, onChange }: { trigger: Trigger; wf: Loaded; onChange: (t: Trigger) => void }) {
  const { t } = useLanguage();
  const id = useId();
  const published = wf.trigger && wf.live && wf.trigger.type === trigger.type ? wf.trigger : null;
  const fields = trigger.type === "form" ? trigger.config.fields : [];
  const setFields = (next: FormField[]) => onChange({ type: "form", config: { fields: next } });
  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{t("Trigger")}</h2>
      <div className="field">
        <label htmlFor={`${id}-type`}>{t("Starts when")}</label>
        <select id={`${id}-type`} value={trigger.type} onChange={(e) => onChange(TRIGGER_DEFAULTS[e.target.value as Trigger["type"]])}>
          <option value="manual">{t("Started by hand")}</option>
          <option value="webhook">{t("A webhook is called")}</option>
          <option value="schedule">{t("On a schedule")}</option>
          <option value="form">{t("A form is submitted")}</option>
          <option value="email">{t("An email arrives")}</option>
          <option value="payment">{t("When a PayMongo payment is confirmed")}</option>
        </select>
      </div>
      {trigger.type === "payment" && (
        <fieldset>
          <legend>{t("Run when a payment is")}</legend>
          {(["paid", "refunded"] as const).map((e) => (
            <label key={e}>
              <input
                type="checkbox"
                checked={trigger.config.events.includes(e)}
                onChange={(ev) => {
                  const events = ev.target.checked ? [...trigger.config.events, e] : trigger.config.events.filter((x) => x !== e);
                  if (events.length) onChange({ type: "payment", config: { events } });
                }}
              />{" "}
              {t(e)}
            </label>
          ))}
        </fieldset>
      )}
      {trigger.type === "email" && <EmailSource workflowId={wf.id} published={wf.trigger?.type === "email" && !!wf.live} />}
      {trigger.type === "schedule" && (
        <div className="field">
          <label htmlFor={`${id}-cron`}>{t("Cron expression (UTC)")}</label>
          <input id={`${id}-cron`} value={trigger.config.cron} onChange={(e) => onChange({ type: "schedule", config: { cron: e.target.value } })} />
        </div>
      )}
      {trigger.type === "webhook" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-hmac`}>
              {t("Signing secret name")} <span className="muted">{t("(optional)")}</span>
            </label>
            <input id={`${id}-hmac`} value={trigger.config.hmacSecret ?? ""} onChange={(e) => onChange({ type: "webhook", config: { ...trigger.config, hmacSecret: e.target.value || undefined } })} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-event-key`}>
              {t("Event key")} <span className="muted">{t("(optional, e.g. {example}: a repeated event starts no second run)", { example: "{{trigger.event_id}}" })}</span>
            </label>
            <input id={`${id}-event-key`} value={trigger.config.eventKey ?? ""} onChange={(e) => onChange({ type: "webhook", config: { ...trigger.config, eventKey: e.target.value || undefined } })} />
          </div>
        </>
      )}
      {trigger.type === "form" && (
        <fieldset>
          <legend>{t("Form fields")}</legend>
          {fields.map((f, i) => {
            const set = (patch: Partial<FormField>) => setFields(fields.map((g, j) => (j === i ? { ...g, ...patch } : g)));
            return (
              <div className="row" key={i}>
                <input aria-label={t("Field {number} name", { number: i + 1 })} value={f.name} onChange={(e) => set({ name: e.target.value })} />
                <input aria-label={t("Field {number} label", { number: i + 1 })} value={f.label} onChange={(e) => set({ label: e.target.value })} />
                {/* Number limits and datetime zones only exist on their own types, so changing the type drops them. */}
                <select
                  aria-label={t("Field {number} type", { number: i + 1 })}
                  value={f.type}
                  onChange={(e) => {
                    const type = e.target.value as FormField["type"];
                    set({ type, min: undefined, max: undefined, integer: undefined, slotMinutes: undefined, timezone: type === "datetime" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined });
                  }}
                >
                  {["text", "email", "textarea", "number", "datetime", "resource", "file"].map((kind) => (
                    <option key={kind} value={kind}>{t(kind)}</option>
                  ))}
                </select>
                <label className="check">
                  <input type="checkbox" checked={f.required} onChange={(e) => set({ required: e.target.checked })} /> {t("required")}
                </label>
                {f.type === "number" && (
                  <>
                    <input aria-label={t("Field {number} minimum", { number: i + 1 })} type="number" step="any" placeholder={t("min")} value={f.min ?? ""} onChange={(e) => set({ min: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    <input aria-label={t("Field {number} maximum", { number: i + 1 })} type="number" step="any" placeholder={t("max")} value={f.max ?? ""} onChange={(e) => set({ max: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    <label className="check">
                      <input type="checkbox" checked={f.integer ?? false} onChange={(e) => set({ integer: e.target.checked || undefined })} /> {t("whole number")}
                    </label>
                  </>
                )}
                {f.type === "datetime" && (
                  <>
                    <input aria-label={t("Field {number} timezone", { number: i + 1 })} placeholder="Asia/Manila" value={f.timezone ?? ""} onChange={(e) => set({ timezone: e.target.value })} />
                    <input aria-label={t("Field {number} slot minutes", { number: i + 1 })} type="number" min={1} max={1440} step={1} placeholder={t("slot minutes")} value={f.slotMinutes ?? ""} onChange={(e) => set({ slotMinutes: e.target.value === "" ? undefined : Number(e.target.value) })} />
                  </>
                )}
                {f.type === "resource" && <span className="muted">{t("a resource from the Resources page")}</span>}
                {f.type === "file" && <span className="muted">{t("photos or PDFs, up to 5 MB each, 3 per field")}</span>}
                <button type="button" className="quiet" onClick={() => setFields(fields.filter((_, j) => j !== i))} disabled={fields.length === 1}>
                  {t("Remove")}
                </button>
              </div>
            );
          })}
          <button type="button" className="quiet" onClick={() => setFields([...fields, { name: `field_${fields.length + 1}`, label: t("New field"), type: "text", required: false }])}>
            {t("Add field")}
          </button>
        </fieldset>
      )}
      {published?.webhookPath && (
        <p className="muted hint">
          {t("Webhook URL:")} <code>{`${location.origin}/hooks/${published.webhookPath}`}</code>
        </p>
      )}
      {published && trigger.type === "form" && (
        <div className="actions">
          {t("Public form:")} <a href={`/forms/${published.id}`}>{`${location.origin}/forms/${published.id}`}</a>
          <FormEmbed link={`${location.origin}/forms/${published.id}`} />
        </div>
      )}
    </section>
  );
}

const OUTSIDE = new Set(["http", "email", "approval", "sheets", "drive", "slack", "outlook", "teams", "telegram", "calendar", "airtable", "notion", "trello"]);

/** Per-step outcomes for a mocked or AI-only test run: a classify label, an approval decision, or a failure. */
function TestChoices({ steps, choices, onChange }: { steps: Step[]; choices: Record<string, string>; onChange: (c: Record<string, string>) => void }) {
  const { t } = useLanguage();
  const options = (s: Step): [string, string][] => [
    ...(s.type === "ai" && s.config.task === "classify" ? Object.keys(s.config.labels ?? {}).map((l): [string, string] => [JSON.stringify({ label: l }), t("label {label}", { label: l })]) : []),
    ...(s.type === "approval" ? ["approved", "rejected", "timeout"].map((d): [string, string] => [JSON.stringify({ decision: d }), t(d)]) : []),
    ...(OUTSIDE.has(s.type) ? (["retryable", "permanent"] as const).map((f): [string, string] => [JSON.stringify({ fail: f }), t("fail ({kind})", { kind: t(f) })]) : []),
  ];
  const choosable = steps.filter((s) => options(s).length > 0);
  if (choosable.length === 0) return null;
  return (
    <fieldset>
      <legend>{t("Test outcomes")}</legend>
      {choosable.map((s) => (
        <div className="row" key={s.id}>
          <label htmlFor={`choice-${s.id}`}>{s.id}</label>
          <select id={`choice-${s.id}`} value={choices[s.id] ?? ""} onChange={(e) => onChange({ ...choices, [s.id]: e.target.value })}>
            <option value="">{t(s.type === "approval" ? "approved (default)" : s.type === "ai" ? "model or mock (default)" : "succeeds (default)")}</option>
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
