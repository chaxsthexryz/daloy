import "./automations-ops.css";
import "./guided-pages.css";
import {
  answersFromDefinition,
  applyAskAnswers,
  askLabel,
  asksForTemplate,
  explainFlow,
  type AskAnswers,
  type GeneratedSetup,
  type ReadinessReport,
  type TemplateAsk,
  type WorkflowDefinition,
} from "@daloy/engine";
import { useEffect, useState, type FormEvent } from "react";
import { api, checkWorkflowReadiness, type Run, type RunSummary, type Version, type Workflow } from "./api";
import { Breadcrumb } from "./Breadcrumb";
import { ChatTest } from "./ChatTest";
import { FormEmbed } from "./FormEmbed";
import { Text, useLanguage } from "./Language";
import { AutomationTabs } from "./Nav";
import { StatePill } from "./Runs";
import { shareable, ShareSheet } from "./SharePanel";
import { ago } from "./lib/states";
import { pushToast } from "./Toast";

type Detail = Omit<Workflow, "live"> & {
  trigger: { id: string; type: string; webhookPath: string | null } | null;
  live: Version | null;
  latest: Version | null;
};

type Member = { userId: string; email: string; role: string };

const WIZARD_STEPS = ["questions", "connect", "test", "turnon"] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];

const STEP_TITLE: Record<WizardStep, string> = {
  questions: "Answer a few questions",
  connect: "Connect what is required",
  test: "Send yourself a test",
  turnon: "Turn on",
};

function sampleForTrigger(def: WorkflowDefinition, firstResource?: string): Record<string, unknown> {
  const t = def.trigger;
  if (t.type === "form" || t.type === "sub_workflow") {
    const out: Record<string, unknown> = {};
    for (const f of t.config.fields ?? []) {
      if (f.type === "file") continue;
      if (f.type === "number") out[f.name] = 100;
      else if (f.type === "email") out[f.name] = "sample@example.com";
      else if (f.type === "datetime") out[f.name] = `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T10:00`;
      else if (f.type === "resource") out[f.name] = firstResource ?? "sample-resource";
      else if (/(phone|mobile|whatsapp)/i.test(`${f.name} ${f.label}`)) out[f.name] = "+639171234567";
      else out[f.name] = `Sample ${f.label.toLowerCase()}`;
    }
    return out;
  }
  if (t.type === "email") return { from: "guest@example.com", replyTo: "guest@example.com", to: ["inbox@example.com"], subject: "Inquiry", text: "Hello, how much is a room?" };
  if (t.type === "meta_dm") return { channel: "messenger", senderId: "1234567890", messageId: "m_sample", text: "Hi! How much?", timestamp: new Date().toISOString(), image: [] };
  if (t.type === "whatsapp_message") return { channel: "whatsapp", senderId: "639171234567", senderName: "Ana Reyes", messageId: "wamid.sample", text: "Hi!", timestamp: new Date().toISOString(), image: [] };
  if (t.type === "telegram_message") return { chatId: "123456789", chatType: "private", fromId: "123456789", fromName: "Ana", messageId: 1, updateId: 1, date: new Date().toISOString(), text: "Hello", fileRefused: false };
  return {};
}

export function GeneratedWizard({
  wf,
  setup,
  onDone,
  onCancelEdit,
}: {
  wf: Detail;
  setup: GeneratedSetup | null;
  onDone: () => Promise<void>;
  onCancelEdit?: () => void;
}) {
  const { t, language } = useLanguage();
  const baseDef = ((wf.latest?.definition ?? wf.live?.definition) as WorkflowDefinition | undefined) ?? {
    trigger: { type: "manual", config: {} },
    steps: [],
    edges: [],
  };
  const asks = asksForTemplate(setup?.template, baseDef);
  const [step, setStep] = useState<WizardStep>(setup?.step ?? "questions");
  const [name, setName] = useState(wf.name);
  const [answers, setAnswers] = useState<AskAnswers>(() =>
    answersFromDefinition(baseDef, asks, { ownerEmail: "", businessName: "" }, setup?.answers ?? {}),
  );
  const [approvers, setApprovers] = useState<Member[]>([]);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [resourceName, setResourceName] = useState("");
  const [firstResource, setFirstResource] = useState<string | undefined>();
  const [addingResource, setAddingResource] = useState(false);
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const [testRun, setTestRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void api<{ signInEmail: string; profile: { businessName: string | null } | null }>("GET", "/settings/email").then(
      (s) => {
        setAnswers((prev) =>
          answersFromDefinition(baseDef, asks, { ownerEmail: s.signInEmail, businessName: s.profile?.businessName }, { ...setup?.answers, ...prev }),
        );
      },
      () => undefined,
    );
    void api<Member[]>("GET", "/workspace/members").then(
      (m) => setApprovers(m.filter((x) => x.role === "owner" || x.role === "approver")),
      () => undefined,
    );
    void api<{ id: string; active: boolean }[]>("GET", "/resources").then(
      (r) => setFirstResource(r.find((x) => x.active)?.id),
      () => undefined,
    );
  }, [wf.id]);

  const currentDef = (() => {
    try {
      return applyAskAnswers(baseDef, asks, answers);
    } catch {
      return baseDef;
    }
  })();

  const refreshReadiness = async (def = currentDef) => {
    try {
      const r = await checkWorkflowReadiness(def, wf.id);
      setReadiness(r);
    } catch {
      setReadiness(null);
    }
  };

  useEffect(() => {
    if (step === "connect" || step === "turnon") void refreshReadiness(currentDef);
    const onFocus = () => {
      if (step === "connect" || step === "turnon") void refreshReadiness(currentDef);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [step, wf.id]);

  useEffect(() => {
    if (!testRunId) return;
    let stop = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const r = await api<Run>("GET", `/runs/${testRunId}`);
        if (stop) return;
        setTestRun(r);
        if (r.state === "pending" || r.state === "running" || r.state === "waiting") {
          timer = window.setTimeout(() => void poll(), 800);
        }
      } catch {
        // ignore poll glitch
      }
    };
    void poll();
    return () => {
      stop = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [testRunId]);

  const persistProgress = async (nextStep: WizardStep, nextDef: WorkflowDefinition) => {
    if (name.trim() && name.trim() !== wf.name) {
      await api("PATCH", `/workflows/${wf.id}`, { name: name.trim() });
    }
    await api("PATCH", `/workflows/${wf.id}/setup`, {
      kind: "generated",
      template: setup?.template ?? "custom",
      step: nextStep,
      answers,
    });
    if (nextDef.steps.length > 0) {
      await api("POST", `/workflows/${wf.id}/versions`, { definition: nextDef, publish: false });
    }
  };

  const index = WIZARD_STEPS.indexOf(step);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const nextDef = applyAskAnswers(baseDef, asks, answers);
      if (index < WIZARD_STEPS.length - 1) {
        const nextStep = WIZARD_STEPS[index + 1]!;
        await persistProgress(nextStep, nextDef);
        setStep(nextStep);
        if (nextStep === "connect" || nextStep === "turnon") await refreshReadiness(nextDef);
        return;
      }
      await persistProgress("turnon", nextDef);
      await api("POST", `/workflows/${wf.id}/versions`, { definition: nextDef, publish: true });
      pushToast({ message: t("Automation turned on."), tone: "success" });
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveLater = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await persistProgress(step, currentDef);
      location.hash = "#/automations";
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runSampleTest = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await persistProgress("test", currentDef);
      const r = await api<{ id: string }>("POST", `/workflows/${wf.id}/test-runs`, {
        definition: currentDef,
        payload: sampleForTrigger(currentDef, firstResource),
        mode: "mock",
      });
      setTestRunId(r.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addResource = async (e: FormEvent) => {
    e.preventDefault();
    const clean = resourceName.trim();
    if (!clean || addingResource) return;
    setAddingResource(true);
    try {
      const created = await api<{ id: string }>("POST", "/resources", { name: clean });
      setFirstResource((prev) => prev ?? created.id);
      setResourceName("");
      await refreshReadiness(currentDef);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAddingResource(false);
    }
  };

  const isChatTrigger =
    currentDef.trigger.type === "meta_dm" ||
    currentDef.trigger.type === "whatsapp_message" ||
    currentDef.trigger.type === "telegram_message";

  const turnOnBlocked = step === "turnon" && (!readiness || !readiness.ready || currentDef.steps.length === 0);

  return (
    <main className="page ops gp motion-page">
      <header className="ops-head">
        <div className="gp-title">
          <Breadcrumb items={[{ label: t("Automations"), href: "#/automations" }, { label: name || wf.name }]} />
          <h1>{name || wf.name}</h1>
        </div>
        <div className="ops-actions">
          <span className="gp-tag"><Text>{wf.live ? "Live" : "Draft"}</Text></span>
          {onCancelEdit && (
            <button type="button" className="ops-button" onClick={onCancelEdit}>{t("Back to status")}</button>
          )}
          <a className="ops-button" href={`#/w/${wf.id}`}>{t("Edit steps")}</a>
        </div>
      </header>
      <div className="ops-layout">
        <form className="ops-main" onSubmit={(e) => void onSubmit(e)}>
          <p id="wizard-step" className="gp-eyebrow">
            {t("Step {step} of {total}", { step: index + 1, total: WIZARD_STEPS.length })}
          </p>
          <div className="gp-bar" role="progressbar" aria-valuemin={1} aria-valuemax={WIZARD_STEPS.length} aria-valuenow={index + 1} aria-labelledby="wizard-step">
            {WIZARD_STEPS.map((s, i) => (
              <i key={s} data-done={i <= index ? "" : undefined} />
            ))}
          </div>
          <h2>{t(STEP_TITLE[step])}</h2>

          <div className="gp-body">
            {step === "questions" && (
              <>
                <div className="gp-field">
                  <label htmlFor="wiz-name"><Text>Automation name</Text></label>
                  <input id="wiz-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
                </div>
                {asks.map((ask: TemplateAsk) => (
                  <div className="gp-field" key={ask.key}>
                    <label htmlFor={`wiz-${ask.key}`}>{askLabel(ask, language)}</label>
                    {ask.type === "approver" && approvers.length > 0 ? (
                      <select
                        id={`wiz-${ask.key}`}
                        value={String(answers[ask.key] ?? "")}
                        onChange={(e) => setAnswers({ ...answers, [ask.key]: e.target.value })}
                        required={ask.required}
                      >
                        {approvers.map((m) => (
                          <option key={m.userId} value={m.email}>{m.email} ({t(m.role)})</option>
                        ))}
                      </select>
                    ) : ask.type === "select" && ask.options ? (
                      <select
                        id={`wiz-${ask.key}`}
                        value={String(answers[ask.key] ?? "")}
                        onChange={(e) => setAnswers({ ...answers, [ask.key]: e.target.value })}
                      >
                        {ask.options.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label[language]}</option>
                        ))}
                      </select>
                    ) : ask.type === "textarea" ? (
                      <textarea
                        id={`wiz-${ask.key}`}
                        rows={3}
                        value={String(answers[ask.key] ?? "")}
                        onChange={(e) => setAnswers({ ...answers, [ask.key]: e.target.value })}
                        required={ask.required}
                      />
                    ) : (
                      <input
                        id={`wiz-${ask.key}`}
                        type={ask.type === "email" || ask.type === "approver" ? "email" : ask.type === "number" ? "number" : "text"}
                        value={String(answers[ask.key] ?? "")}
                        onChange={(e) => setAnswers({ ...answers, [ask.key]: e.target.value })}
                        required={ask.required}
                      />
                    )}
                    {ask.help && <p className="gp-hint">{ask.help[language]}</p>}
                  </div>
                ))}
              </>
            )}

            {step === "connect" && (
              <>
                <p className="gp-lead"><Text>kymavo checks your connected apps, rooms, and Knowledge before turning this on.</Text></p>
                {!readiness ? (
                  <p className="gp-hint"><Text>Checking readiness…</Text></p>
                ) : readiness.ready && readiness.warnings.length === 0 ? (
                  <p className="gp-callout"><Text>Everything required is ready.</Text></p>
                ) : (
                  <ul className="r2b-problems">
                    {[...readiness.blockers, ...readiness.warnings].map((b) => (
                      <li key={b.id}>
                        <span>{b.text}</span>
                        {b.fix && (
                          <>
                            {" "}
                            <a href={b.fix}>{t(b.kind === "resource" ? "Manage rooms and resources" : b.kind === "knowledge" ? "Open Knowledge" : b.kind === "operator" ? "See plan and usage" : "Open setup")}</a>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {readiness?.blockers.some((b) => b.kind === "resource") && (
                  <div className="r2b-inline-resource">
                    <label htmlFor="wiz-resource">{t("Add a room or resource")}</label>
                    <div className="r2b-inline-resource-row">
                      <input
                        id="wiz-resource"
                        value={resourceName}
                        onChange={(e) => setResourceName(e.target.value)}
                        placeholder={t("e.g. Deluxe Room")}
                        maxLength={100}
                      />
                      <button type="button" disabled={addingResource || !resourceName.trim()} onClick={(e) => void addResource(e)}>
                        {addingResource ? t("Adding...") : t("Add")}
                      </button>
                    </div>
                  </div>
                )}
                <div className="gp-actions">
                  <button type="button" className="ops-button" onClick={() => void refreshReadiness(currentDef)}>
                    <Text>Refresh checks</Text>
                  </button>
                </div>
              </>
            )}

            {step === "test" && (
              <>
                <p className="gp-lead"><Text>Run a safe sample test. No real emails, messages, or payments go out.</Text></p>
                {currentDef.steps.length === 0 ? (
                  <p className="gp-hint"><Text>Add steps in Edit steps first to run a sample test.</Text></p>
                ) : (
                  <>
                    <div className="gp-actions">
                      <button type="button" className="ops-button" disabled={busy} onClick={() => void runSampleTest()}>
                        <Text>Send sample test</Text>
                      </button>
                    </div>
                    {testRun && (
                      <div className="gp-card">
                        <p><strong>{t("Test result:")}</strong> {testRun.state}</p>
                        <ul>
                          {testRun.steps.map((s) => (
                            <li key={s.id}><span className={`badge ${s.state}`}>{s.state}</span> {s.stepId}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {isChatTrigger && <ChatTest workflowId={wf.id} draft={currentDef} onRun={(id) => setTestRunId(id)} />}
                  </>
                )}
              </>
            )}

            {step === "turnon" && (
              <>
                <p className="gp-callout"><Text>Review what this automation will do, then turn it on.</Text></p>
                <ul className="lib-steps">
                  {explainFlow(currentDef, language).map((line) => <li key={line}>{line}</li>)}
                </ul>
                {readiness && !readiness.ready && (
                  <div className="message error" role="alert">
                    <p>{t("Fix these before turning on:")}</p>
                    <ul>
                      {readiness.blockers.map((b) => (
                        <li key={b.id}>
                          {b.text} {b.fix && <a href={b.fix}>{t("Fix")}</a>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>

          <p role="alert" className="gp-error" hidden={!error}>{error}</p>
          <div className="gp-actions">
            {index > 0 && (
              <button type="button" className="ops-button" disabled={busy} onClick={() => setStep(WIZARD_STEPS[index - 1]!)}>
                {t("Back")}
              </button>
            )}
            <button className={`ops-button ${index === WIZARD_STEPS.length - 1 ? "blue" : "dark"}`} disabled={busy || turnOnBlocked}>
              {busy ? t("Saving…") : index === WIZARD_STEPS.length - 1 ? t("Turn on") : t("Next")}
            </button>
            <button type="button" className="ops-button" disabled={busy} onClick={() => void saveLater()}>
              {t("Save and finish later")}
            </button>
          </div>
        </form>
        <aside className="ops-panel" aria-labelledby="wiz-steps">
          <p id="wiz-steps" className="gp-eyebrow"><Text>Setup steps</Text></p>
          <h2>{name || wf.name}</h2>
          <ol className="gp-steps">
            {WIZARD_STEPS.map((s, i) => (
              <li key={s} aria-current={s === step ? "step" : undefined}>
                <b aria-hidden="true">{i + 1}</b>
                <strong>{t(STEP_TITLE[s])}</strong>
                <span>{t(i < index ? "Complete" : i === index ? "Current step" : "Upcoming")}</span>
              </li>
            ))}
          </ol>
          <p className="gp-note"><Text>Need custom branches or extra steps? Open Edit steps anytime.</Text></p>
        </aside>
      </div>
    </main>
  );
}

/** Calm post-go-live status page at #/a/:id for any live automation. */
export function AutomationStatusPage({
  wf,
  onReload,
  onEditSetup,
}: {
  wf: Detail;
  onReload: () => Promise<void>;
  onEditSetup: () => void;
}) {
  const { t, language } = useLanguage();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const [showShare, setShowShare] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void api<RunSummary[]>("GET", `/runs?workflowId=${wf.id}&test=false&limit=10`).then(setRuns, () => setRuns([]));
  }, [wf.id]);

  const togglePause = async () => {
    setBusy(true);
    setError("");
    try {
      await api("POST", `/workflows/${wf.id}/${wf.pausedAt ? "resume" : "pause"}`);
      pushToast({ message: t(wf.pausedAt ? "Resumed {name}." : "Paused {name}.", { name: wf.name }), tone: "info" });
      await onReload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const formId = wf.trigger?.type === "form" ? wf.trigger.id : null;
  const formLink = formId ? `${location.origin}/forms/${formId}` : null;
  const copyLink = () => {
    if (!formLink) return;
    void navigator.clipboard.writeText(formLink).then(
      () => setCopied(t("Form link copied.")),
      () => setCopied(formLink),
    );
  };

  const today = new Date().toISOString().slice(0, 10);
  const todayRuns = (runs ?? []).filter((r) => r.createdAt.slice(0, 10) === today).length;
  const now = Date.now();

  return (
    <main className="page ops gp gp-live motion-page">
      <header className="ops-head">
        <div className="gp-title">
          <Breadcrumb items={[{ label: t("Automations"), href: "#/automations" }, { label: wf.name }]} />
          <h1>{wf.name}</h1>
        </div>
        <div className="ops-actions">
          <span className={`gp-tag ${wf.pausedAt ? "" : "ok"}`}>{t(wf.pausedAt ? "Paused" : "Running")}</span>
          <button type="button" className="ops-button" disabled={busy} onClick={() => void togglePause()}>
            {t(wf.pausedAt ? "Resume" : "Pause")}
          </button>
          <button type="button" className="ops-button" onClick={onEditSetup}>{t("Setup questions")}</button>
          <a className="ops-button" href={`#/w/${wf.id}`}>{t("Edit steps")}</a>
        </div>
      </header>
      <AutomationTabs id={wf.id} here="overview" overview />
      <div className="ops-layout">
        <div className="ops-main">
          {error && <p role="alert" className="gp-error">{error}</p>}
          {formLink && (
            <section className="gp-card">
              <h2><Text>Share link</Text></h2>
              <p className="gp-hint"><code>{formLink}</code></p>
              {copied && <p role="status" className="gp-hint">{copied}</p>}
              <div className="gp-actions">
                <button type="button" className="ops-button" onClick={copyLink}>{t("Copy form link")}</button>
                <FormEmbed link={formLink} />
                <a className="ops-button" href={formLink} target="_blank" rel="noreferrer">{t("Open form")}</a>
              </div>
            </section>
          )}
          {!formLink && wf.trigger && shareable(wf.trigger.type) && (
            <section className="gp-card">
              <h2><Text>Share</Text></h2>
              <button type="button" className="ops-button" onClick={() => setShowShare(true)}>{t("Share link & setup")}</button>
            </section>
          )}
          <div className="ops-kpis">
            <div>
              <span><Text>Ran today</Text></span>
              <b>{todayRuns}</b>
            </div>
            <div>
              <span><Text>Recent runs</Text></span>
              <b>{(runs ?? []).length}</b>
            </div>
          </div>
          <div className="ops-head">
            <h2><Text>Recent activity</Text></h2>
            <a className="ops-button" href={`#/w/${wf.id}/runs`}>{t("View activity")}</a>
          </div>
          {runs === null ? (
            <p className="gp-hint"><Text>Loading…</Text></p>
          ) : runs.length === 0 ? (
            <p className="gp-hint"><Text>No runs yet. When this automation triggers, runs appear here.</Text></p>
          ) : (
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col"><Text>Run</Text></th>
                  <th scope="col"><Text>Status</Text></th>
                  <th scope="col"><Text>When</Text></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td><a href={`#/runs/${r.id}`}>{r.reference ?? r.id.slice(0, 8)}</a></td>
                    <td><StatePill run={r} /></td>
                    <td>{ago(r.createdAt, now, language)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {showShare && wf.trigger && (
        <ShareSheet
          info={{
            slug: wf.slug,
            live: wf.live ? (wf.live.definition as WorkflowDefinition).trigger : null,
            triggerId: wf.trigger.id,
            webhookPath: wf.trigger.webhookPath,
          }}
          onClose={() => setShowShare(false)}
        />
      )}
    </main>
  );
}
