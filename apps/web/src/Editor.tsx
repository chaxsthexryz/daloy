import "./editor.css";
import { useLanguage } from "./Language";
import { configProblems, definitionSchema, destination, lintDefinition, markText, stepEntry, stepLabel, triggerEntry, triggerLabel, type FormField, type Step, type Trigger } from "@daloy/engine";
import { AppMark } from "./AppMark";
import { Background, ReactFlow, type NodeChange } from "@xyflow/react";
import { useEffect, useId, useMemo, useState } from "react";
import { AskAi } from "./AiDraft";
import { FormEmbed } from "./FormEmbed";
import { api, type Version, type Workflow } from "./api";
import { editorEdgeTypes, editorNodeTypes, flowAriaLabels, ZoomBar } from "./FlowCanvas";
import { RunResult, useRun } from "./Runs";
import { ADDABLE, addStep, blankDraft, removeStep, toFlow, type AddableType, type Draft } from "./lib/graph";
import { chosenFor, insertables, nextPaths, setupLeft, unconnectedNodes, type ConnInfo } from "./lib/editor";
import { warningForLanguage } from "./lib/ai-build";
import { runFlow } from "./lib/run-flow";
import { AutomationTabs } from "./Nav";
import { SchemaForm, type JsonSchema } from "./SchemaForm";
import { EmailSource } from "./EmailSource";
import { ExplainSheet, SampleTest, SetupGuide, TurnOnSheet } from "./Guide";
import { testState, type SampleResult } from "./lib/guide";

const explainedKey = (id: string) => `daloy.explained.${id}`;
const wasExplained = (id: string) => {
  try {
    return localStorage.getItem(explainedKey(id)) === "1";
  } catch {
    return false; // storage can be blocked; the dialog then shows again, which is harmless
  }
};

type Catalog = { schemas: Record<string, JsonSchema>; branches: Record<string, string[]> };
type Loaded = Workflow & { trigger: { id: string; type: string; webhookPath: string | null; legacySignatureAt?: string | null } | null; live: Version | null; latest: Version | null };

// Tomorrow at 10:00 in the field's own zone, which is on any slot grid that divides the hours evenly.
const tomorrowAtTen = () => `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T10:00`;

function samplePayload(trigger: Trigger, resourceId = "a resource id from the Resources page"): string {
  if (trigger.type === "email") return JSON.stringify({ from: "ana@example.com", replyTo: "ana@example.com", to: ["inquiries@example.com"], subject: "Website inquiry", text: "I would like a quote.", messageId: "sample-inquiry@example.com", receivedAt: new Date().toISOString() }, null, 2);
  if (trigger.type === "meta_dm") return JSON.stringify({ channel: trigger.config.channel === "instagram" ? "instagram" : "messenger", senderId: "1234567890", messageId: "m_sample_1", text: "Here is my GCash receipt.", timestamp: new Date().toISOString(), image: [] }, null, 2);
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
  // null until GET /settings/connections answers; a refused or failed read leaves it null and hides the setup banner.
  const [connected, setConnected] = useState<ReadonlySet<string> | null>(null);
  const [conns, setConns] = useState<ConnInfo[]>([]);
  // True until GET /settings/email answers, so a node never flashes "Connect Gmail" while the answer is on its way.
  const [mailReady, setMailReady] = useState(true);
  // A phone shows the list first: the whole diagram fitted to 360px is too small to read.
  const [view, setView] = useState<"diagram" | "list">(() => (matchMedia("(max-width: 599.98px)").matches ? "list" : "diagram"));
  const [copied, setCopied] = useState<string | null>(null);
  // R2b: the last test run and the draft it ran on, the dialogs, and whether the owner has read "Explain this flow".
  const [sample, setSample] = useState<SampleResult | null>(null);
  const { run: sampleRun } = useRun(sample?.runId ?? null);
  const [showExplain, setShowExplain] = useState(false);
  const [showTurnOn, setShowTurnOn] = useState(false);
  const [explained, setExplained] = useState(() => wasExplained(id));

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
        // After guided setup, show the explanation once for a draft that is not live yet.
        if (w.setup && !w.live && d.steps.length > 0 && !wasExplained(id)) setShowExplain(true);
      })
      .catch((e: Error) => setMessage({ kind: "error", text: e.message }));
    api<{ connections: ConnInfo[] }>("GET", "/settings/connections").then(
      (r) => {
        setConns(r.connections);
        setConnected(new Set(r.connections.filter((c) => c.status === "active").map((c) => c.provider)));
      },
      () => setConnected(null),
    );
    api<{ sender: { status: string } | null; installationAllowed: boolean }>("GET", "/settings/email").then(
      (m) => setMailReady(m.sender?.status === "active" || m.installationAllowed),
      () => setMailReady(true),
    );
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
  const apps = useMemo(() => (connected ? setupLeft(draft, connected) : []), [draft, connected]);
  const missingApp = new Map(apps.filter((a) => !a.connected).flatMap((a) => a.steps.map((s) => [s, a.label] as const)));
  const chosen = useMemo(() => chosenFor(draft, conns), [draft, conns]);
  const unconnected = useMemo(() => (connected ? unconnectedNodes(draft, connected, mailReady) : new Map<string, string>()), [draft, connected, mailReady]);
  const nodes = flow.nodes.map((n) => ({
    ...n,
    ...(measured[n.id] && { measured: measured[n.id] }),
    data: { ...n.data, index: draft.steps.findIndex((s) => s.id === n.id) + 1, needsApp: unconnected.get(n.id), chosen: chosen.get(n.id) },
  }));
  // Every editor edge uses the square editor edge; it carries the branch so the pill can take its colour.
  const edges = flow.edges.map((e) => ({ ...e, type: "editor", data: { ...e.data, on: e.sourceHandle ?? undefined } }));

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
  const testRun = (testMode: typeof mode = mode) =>
    act("Test run", async () => {
      const r = await api<{ id: string; duplicate?: boolean; mode?: string }>("POST", `/workflows/${id}/test-runs`, {
        definition: draft,
        payload: parsedPayload(),
        mode: testMode,
        choices: testMode === "live" ? {} : Object.fromEntries(draft.steps.flatMap((s) => (choices[s.id] ? [[s.id, JSON.parse(choices[s.id]!) as unknown]] : []))),
      });
      setDirty(false);
      setRunId(r.id);
      setSample({ key: JSON.stringify(draft), runId: r.id });
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

  if (!wf || !catalog) return <main className="page a7-loading">{message ? <p role="alert">{message.text}</p> : <p>{t("Loading…")}</p>}</main>;

  const step = draft.steps.find((s) => s.id === selected);
  const problems = configProblems(draft, language);
  const test = testState(JSON.stringify(draft), sample, sample ? (sampleRun?.id === sample.runId ? sampleRun.state : null) : null);
  const closeExplain = () => {
    setShowExplain(false);
    setExplained(true);
    try {
      localStorage.setItem(explainedKey(id), "1");
    } catch {
      /* storage blocked: the dialog may show again */
    }
  };
  const status = dirty ? t("Unsaved changes") : wf.latest ? t("Version {version}{state}", { version: wf.latest.version, state: t(wf.latest.published ? " (live)" : ", draft") }) : t("Not saved yet");
  const isLive = !dirty && !!wf.latest?.published;
  const missing = apps.filter((a) => !a.connected);
  const select = (next: string | null) => {
    setSelected(next);
    setCopied(null);
  };
  const editStep = (config: unknown) => update({ ...draft, steps: draft.steps.map((s) => (s.id === step!.id ? ({ ...s, config } as Step) : s)) });
  const copy = (reference: string) =>
    navigator.clipboard.writeText(reference).then(
      () => setCopied(t("Copied {reference}", { reference })),
      () => setCopied(t("Copy failed. Type {reference} into a text field.", { reference })),
    );
  const showRun = () => document.getElementById("run-heading")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });

  return (
    <div className="a7-editor">
      <header className="a7-head">
        <div className="a7-head-main">
          <p className="a7-crumb">
            <a href="#/">{t("Automations")}</a> / {t(wf.live ? "Live" : "Drafts")}
          </p>
          <div className="a7-title">
            <h1>{wf.name}</h1>
            <span className="a7-chip" data-live={isLive || undefined}>
              {t(isLive ? "Live" : "Draft")}
            </span>
            <span className="a7-meta status" aria-live="polite">
              {status}
              {wf.live && !wf.latest?.published && t(" · version {version} is live", { version: wf.live.version })}
            </span>
          </div>
          <div className="a7-tabs">
            <AutomationTabs id={id} here="steps" overview={!!wf.setup && !!wf.live} />
            <a href={`#/w/${id}/versions`}>{t("Versions")}</a>
          </div>
        </div>
        <div className="a7-actions">
          <button
            type="button"
            onClick={() => {
              showRun();
              void testRun();
            }}
            disabled={busy || draft.steps.length === 0}
          >
            {t("Test run")}
          </button>
          <button type="button" onClick={() => setShowExplain(true)} disabled={draft.steps.length === 0}>
            {t("Explain this flow")}
          </button>
          <button type="button" onClick={() => save(false)} disabled={busy || draft.steps.length === 0}>
            {t("Save")}
          </button>
          <button type="button" className="primary" onClick={() => setShowTurnOn(true)} disabled={busy || draft.steps.length === 0}>
            {t("Publish")}
          </button>
        </div>
      </header>
      <div className="a7-body">
        <section className="a7-canvas" aria-label={t("Workflow diagram. Tab to a step and press Enter to select it, Delete to remove it.")}>
          {missing.length > 0 && (
            <div className="a7-setup">
              <p className="a7-setup-count">{t("{done} of {total} apps connected", { done: apps.length - missing.length, total: apps.length })}</p>
              <span className="a7-setup-bars" aria-hidden="true">
                {apps.map((a) => (
                  <span key={a.provider} data-done={a.connected || undefined} />
                ))}
              </span>
              <p className="a7-setup-left">{t("Left: connect {apps}", { apps: missing.map((a) => t(a.label)).join(", ") })}</p>
              <a className="a7-setup-action" href="#/apps">
                {t("Connect {app}", { app: t(missing[0]!.label) })}
              </a>
            </div>
          )}
          <div className="a7-view" role="group" aria-label={t("Show steps as")}>
            <button type="button" aria-pressed={view === "diagram"} onClick={() => setView("diagram")}>
              {t("Diagram")}
            </button>
            <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
              {t("List")}
            </button>
          </div>
          {view === "diagram" ? (
            <div className="a7-flow">
              <ReactFlow
                ariaLabelConfig={flowAriaLabels(language)}
                nodes={nodes}
                edges={edges}
                nodeTypes={editorNodeTypes}
                edgeTypes={editorEdgeTypes}
                onNodesChange={onNodesChange}
                onPaneClick={() => select(null)}
                nodesDraggable={false}
                nodesConnectable={false}
                deleteKeyCode="Delete"
                colorMode={document.documentElement.dataset.theme === "dark" ? "dark" : "light"}
                proOptions={{ hideAttribution: true }}
                fitView
                fitViewOptions={{ maxZoom: 1 }}
              >
                <Background gap={18} size={1.5} />
                <ZoomBar />
              </ReactFlow>
            </div>
          ) : (
            <StepList draft={draft} selected={selected} onSelect={select} chosen={chosen} />
          )}
          <button
            type="button"
            className="a7-add"
            onClick={() => {
              const field = document.getElementById("add-step-type");
              field?.scrollIntoView({ block: "center" });
              field?.focus();
            }}
          >
            <span aria-hidden="true">+</span> {t("Add step")}
          </button>
        </section>
        <aside className="a7-panel">
          {message && (
            <p role={message.kind === "error" ? "alert" : "status"} className={`message ${message.kind}`}>
              {message.text}
            </p>
          )}
          <SetupGuide facts={{ missingApps: missing.length, problems: problems.length, explained, test, live: isLive }} onExplain={() => setShowExplain(true)} onTry={() => void testRun("mock")} onTurnOn={() => setShowTurnOn(true)} />
          <SampleTest draft={draft} apps={apps} test={test} run={sampleRun} busy={busy} onTry={() => void testRun("mock")} />
          {selected === "trigger" && (
            <div className="a7-inspector">
              <p className="a7-kicker a7-when">{t("When")}</p>
              <TriggerPanel
                trigger={draft.trigger}
                wf={wf}
                onChange={(trigger) => {
                  // A new trigger type gets matching sample data; edits within a type keep what the user typed.
                  if (trigger.type !== draft.trigger.type) setPayload(samplePayload(trigger, firstResource));
                  update({ ...draft, trigger });
                }}
              />
              <NextUp draft={draft} id="trigger" />
            </div>
          )}
          {step && (
            <section className="a7-inspector" aria-labelledby="step-heading">
              <div className="a7-kicker-row">
                <p className="a7-kicker">{t("Step {number} · {type}", { number: draft.steps.indexOf(step) + 1, type: stepLabel(step.type, language) })}</p>
                <button
                  type="button"
                  className="a7-delete"
                  onClick={() => {
                    update(removeStep(draft, step.id));
                    select(null);
                  }}
                >
                  {t("Delete step")}
                </button>
              </div>
              <h2 id="step-heading">{step.id}</h2>
              <p className="a7-lead">{destination(step, { language, trigger: draft.trigger, chosen: chosen.get(step.id) })}</p>
              <p className="muted a7-describe">{stepEntry(step.type).description[language]}</p>
              {missingApp.get(step.id) && (
                <p className="a7-warn-note">
                  {t("{app} is not connected yet.", { app: t(missingApp.get(step.id)!) })} <a href="#/apps">{t("Connect in Apps")}</a>
                </p>
              )}
              <SchemaForm key={step.id} schema={step.type === "ai" ? withoutFiles(catalog.schemas.ai!) : catalog.schemas[step.type]!} value={step.config as Record<string, unknown>} onChange={editStep} />
              {step.type === "ai" &&
                ((draft.trigger.type === "form" && draft.trigger.config.fields.some((f) => f.type === "file")) || draft.trigger.type === "meta_dm") && (
                <fieldset>
                  <legend>{t("Let the AI read these files")}</legend>
                  {(draft.trigger.type === "form"
                    ? draft.trigger.config.fields.filter((f) => f.type === "file").map((f) => ({ name: f.name, label: f.label }))
                    : [{ name: "image", label: t("DM photo attachment") }]
                  ).map((f) => (
                    <label key={f.name} className="check">
                      <input
                        type="checkbox"
                        checked={(step.config as { files?: string[] }).files?.includes(f.name) ?? false}
                        onChange={(e) => {
                          const { files = [], ...rest } = step.config as { files?: string[] };
                          const next = e.target.checked ? [...files, f.name] : files.filter((n) => n !== f.name);
                          editStep(next.length ? { ...rest, files: next } : rest);
                        }}
                      />
                      {f.label}
                    </label>
                  ))}
                  <p className="muted hint">{t("Checked files are sent to the AI model you picked on the AI model page. Photos need Gemini, OpenAI or OpenRouter.")}</p>
                </fieldset>
              )}
              <section className="a7-group" aria-labelledby="insert-heading">
                <h3 id="insert-heading">{t("Insert data from earlier steps")}</h3>
                <p className="muted hint">
                  {t("Use {trigger}, {step} and {secret} in text fields.", { trigger: "{{trigger.field}}", step: "{{steps.step_id.output.field}}", secret: "{{secrets.name}}" })}
                </p>
                <ul className="a7-chips">
                  {insertables(draft, step.id).map((r) => (
                    <li key={r}>
                      <button type="button" onClick={() => void copy(r)} aria-label={t("Copy {reference}", { reference: r })}>
                        {r.slice(2, -2).replace(/^steps\.|\.output/g, "")}
                      </button>
                    </li>
                  ))}
                </ul>
                {copied && (
                  <p role="status" className="a7-copied">
                    {copied}
                  </p>
                )}
              </section>
              <NextUp draft={draft} id={step.id} />
            </section>
          )}
          {!selected && (
            <div className="a7-overview">
              <h2>{t("Steps")}</h2>
              <p className="muted">{t("Select a step in the diagram or the list to change it.")}</p>
            </div>
          )}
          {warnings.length > 0 && (
            <section className="a7-checks" aria-labelledby="checks-heading">
              <h2 id="checks-heading">{t("Check before publishing")}</h2>
              <ul>
                {warnings.map((w) => (
                  <li key={w}>{warningForLanguage(w, language)}</li>
                ))}
              </ul>
            </section>
          )}
          <AddStep
            draft={draft}
            after={step}
            branches={step ? catalog.branches[step.type] : undefined}
            onAdd={(type, on) => {
              const r = addStep(draft, type, step ? { id: step.id, on } : undefined, language);
              update(r.draft);
              select(r.id);
            }}
          />
          <div className="a7-ai">
            <AskAi
              workflowId={id}
              draft={draft}
              onApply={(d) => {
                update(d);
                select(null);
                setPayload(samplePayload(d.trigger, firstResource));
              }}
            />
          </div>
          <section className="a7-test" aria-labelledby="run-heading">
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
              <button type="button" onClick={() => void testRun()} disabled={busy || draft.steps.length === 0}>
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
      </div>
      {showExplain && <ExplainSheet draft={draft} chosen={chosen} onClose={closeExplain} />}
      {showTurnOn && (
        <TurnOnSheet
          draft={draft}
          apps={apps}
          chosen={chosen}
          test={test}
          problems={problems.length}
          onConfirm={() => {
            setShowTurnOn(false);
            void save(true);
          }}
          onClose={() => setShowTurnOn(false)}
        />
      )}
    </div>
  );
}

/** The accessible list: every step as a button, in order, with the branch that leads to it. */
function StepList({ draft, selected, onSelect, chosen }: { draft: Draft; selected: string | null; onSelect: (id: string) => void; chosen: ReadonlyMap<string, string> }) {
  const { t, language } = useLanguage();
  return (
    <ol className="a7-list" aria-label={t("Steps")}>
      <li>
        <button type="button" aria-pressed={selected === "trigger"} onClick={() => onSelect("trigger")}>
          <AppMark decorative mark={triggerEntry(draft.trigger.type).mark} name={markText(triggerEntry(draft.trigger.type), language)} size={24} />
          {t("Trigger: {type}", { type: triggerLabel(draft.trigger.type, language) })}
        </button>
      </li>
      {draft.steps.map((s, i) => {
        const into = draft.edges.filter((e) => e.to === s.id && e.on);
        return (
          <li key={s.id}>
            <button type="button" aria-pressed={selected === s.id} onClick={() => onSelect(s.id)}>
              {/* The id comes first so the button's name starts with it; CSS puts the kicker before it. */}
              <AppMark decorative mark={stepEntry(s.type).mark} name={markText(stepEntry(s.type), language)} size={24} />
              <span className="a7-list-id">{s.id}</span>{" "}
              <span className="a7-list-kicker">
                {i + 1} · {stepLabel(s.type, language)}
              </span>
              <span className="a7-list-where">{destination(s, { language, trigger: draft.trigger, chosen: chosen.get(s.id) })}</span>
              {into.map((e) => (
                <span key={e.from} className="a7-branch" data-branch={e.on}>
                  {t("{from} on {branch}", { from: e.from, branch: t(e.on!) })}
                </span>
              ))}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** What runs after this step, branch by branch. */
function NextUp({ draft, id }: { draft: Draft; id: string }) {
  const { t } = useLanguage();
  const paths = nextPaths(draft, id);
  return (
    <section className="a7-group" aria-labelledby={`next-${id}`}>
      <h3 id={`next-${id}`}>{t("What happens next")}</h3>
      {paths.length === 0 ? (
        <p className="muted">{t("The run ends here.")}</p>
      ) : (
        <dl className="a7-next">
          {paths.map((p) => (
            <div key={p.on ?? "next"}>
              <dt className="a7-branch-text" data-branch={p.on}>
                {p.on ? t(p.on) : t("Next")}
              </dt>
              <dd>{p.steps.map((s) => s.id).join(", ")}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function AddStep({ draft, after, branches, onAdd }: { draft: Draft; after?: Step; branches?: string[]; onAdd: (type: AddableType, on?: string) => void }) {
  const { t, language } = useLanguage();
  const [type, setType] = useState<AddableType>("http");
  const [on, setOn] = useState("");
  const where = after ? t("after {id}", { id: after.id }) : t(draft.steps.length ? "at the start" : "as the first step");
  return (
    <div className="add-step">
      <div className="field">
        <label htmlFor="add-step-type">{t("Add a step {where}", { where })}</label>
        <div className="row">
          <select id="add-step-type" value={type} onChange={(e) => setType(e.target.value as AddableType)}>
            {ADDABLE.map((kind) => (
              <option key={kind} value={kind}>
                {stepLabel(kind, language)}
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

const TRIGGER_ORDER: Trigger["type"][] = ["manual", "webhook", "schedule", "form", "email", "payment", "meta_dm"];
const TRIGGER_DEFAULTS: Record<Trigger["type"], Trigger> = {
  manual: { type: "manual", config: {} },
  email: { type: "email", config: {} },
  webhook: { type: "webhook", config: {} },
  schedule: { type: "schedule", config: { cron: "0 9 * * 1" } },
  form: { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }] } },
  payment: { type: "payment", config: { events: ["paid"] } },
  meta_dm: { type: "meta_dm", config: { channel: "both", requireImage: false } },
};

function TriggerPanel({ trigger, wf, onChange }: { trigger: Trigger; wf: Loaded; onChange: (t: Trigger) => void }) {
  const { t, language } = useLanguage();
  const id = useId();
  const published = wf.trigger && wf.live && wf.trigger.type === trigger.type ? wf.trigger : null;
  const [newPath, setNewPath] = useState<string | null>(null);
  const fields = trigger.type === "form" ? trigger.config.fields : [];
  const setFields = (next: FormField[]) => onChange({ type: "form", config: { fields: next } });
  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{t("Trigger")}</h2>
      <div className="field">
        <label htmlFor={`${id}-type`}>{t("Starts when")}</label>
        <select id={`${id}-type`} value={trigger.type} onChange={(e) => onChange(TRIGGER_DEFAULTS[e.target.value as Trigger["type"]])}>
          {TRIGGER_ORDER.map((type) => (
            <option key={type} value={type}>
              {triggerLabel(type, language)}
            </option>
          ))}
        </select>
      </div>
      {trigger.type === "meta_dm" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-meta-channel`}>{t("Channel")}</label>
            <select
              id={`${id}-meta-channel`}
              value={trigger.config.channel}
              onChange={(e) => onChange({ type: "meta_dm", config: { ...trigger.config, channel: e.target.value as "messenger" | "instagram" | "both" } })}
            >
              <option value="both">{t("Messenger and Instagram")}</option>
              <option value="messenger">{t("Facebook Messenger only")}</option>
              <option value="instagram">{t("Instagram DM only")}</option>
            </select>
          </div>
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={trigger.config.requireImage}
                onChange={(e) => onChange({ type: "meta_dm", config: { ...trigger.config, requireImage: e.target.checked } })}
              />{" "}
              {t("Only run when the message includes a photo")}
            </label>
          </div>
          <p className="muted hint">
            <a href="#/apps">{t("Connect Facebook Messenger & Instagram in Apps")}</a>
          </p>
        </>
      )}
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
            <input id={`${id}-hmac`} value={trigger.config.hmacSecret ?? ""} onChange={(e) => onChange({ type: "webhook", config: { ...trigger.config, hmacSecret: e.target.value || undefined, requireTimestamp: e.target.value ? (trigger.config.hmacSecret ? trigger.config.requireTimestamp : true) : undefined } })} />
            <p className="muted hint"><a href="#/secrets">{t("Manage secrets")}</a></p>
          </div>
          {trigger.config.hmacSecret && (
            <div className="field">
              <label>
                <input type="checkbox" checked={trigger.config.requireTimestamp === true} onChange={(e) => onChange({ type: "webhook", config: { ...trigger.config, requireTimestamp: e.target.checked || undefined } })} />{" "}
                {t("Require the timestamp (recommended)")}
              </label>
              <p className="muted hint">
                {t("The caller sends X-Daloy-Timestamp (unix seconds) and signs the timestamp, a dot and the body: X-Daloy-Signature: sha256=HMAC-SHA256 of \"timestamp.body\". Calls more than 5 minutes off are refused, so a captured call cannot be replayed later.")}
              </p>
              {wf.trigger?.legacySignatureAt && !trigger.config.requireTimestamp && (
                <p role="status" className="message error">
                  {t("A call signed without a timestamp was accepted on {date}. Update the caller, then turn this on.", { date: new Date(wf.trigger.legacySignatureAt).toLocaleString() })}
                </p>
              )}
            </div>
          )}
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
          {t("Webhook URL:")} <code>{`${location.origin}/hooks/${newPath ?? published.webhookPath}`}</code>{" "}
          <button
            type="button"
            className="quiet"
            onClick={() =>
              window.confirm(t("The old URL stops working at once. Continue?")) &&
              api<{ webhookPath: string }>("POST", `/workflows/${wf.id}/webhook-url`).then((r) => setNewPath(r.webhookPath), (e: Error) => window.alert(e.message))
            }
          >
            {t("New URL")}
          </button>
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

const OUTSIDE = new Set(["http", "email", "approval", "sheets", "drive", "slack", "outlook", "teams", "telegram", "sms", "calendar", "airtable", "notion", "trello", "meta_reply"]);

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
