import "./automations-ops.css";
import "./guided-pages.css";
import "./request-access.css";
import { Text, useLanguage } from "./Language";
import { Breadcrumb } from "./Breadcrumb";
import type { Language } from "./lib/locale";
import {
  defaultAnswers,
  defaultPurchaseAnswers,
  OFFICE_REQUEST,
  officeRequestDefinition,
  previewOfficeRequest,
  previewPurchaseRequest,
  PURCHASE_REQUEST,
  PURCHASE_SETUP_STEPS,
  purchaseRequestDefinition,
  SAMPLE_PURCHASE,
  SAMPLE_REQUEST,
  SETUP_STEPS,
  type OfficeRequestAnswers,
  type PurchaseRequestAnswers,
  type PurchaseSetup,
  type GeneratedSetup,
  type Setup,
  type WorkflowDefinition,
} from "@daloy/engine";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type Version, type Workflow } from "./api";
import { FormEmbed } from "./FormEmbed";
import { DeliveryList, type Delivery } from "./Connections";
import { AutomationStatusPage, GeneratedWizard } from "./GuidedWizard";
import { newestDraft } from "./lib/drafts";
import { needsAttention, requestCounts, requestKind, stepStates, type RequestKind } from "./lib/guided";
import { MailNotice } from "./MailNotice";
import { AutomationTabs } from "./Nav";
import { TAKING_LONGER } from "./Runs";

type Step = (typeof SETUP_STEPS)[number];
type Detail = Omit<Workflow, "live"> & { trigger: { id: string; type: string; webhookPath: string | null } | null; live: Version | null; latest: Version | null };
type RequestRow = { id: string; reference: string; subject: string; createdAt: string; runId: string; runState: string; runError: string | null; deliveries: Delivery[] };

/** "Set up for my office": a new workflow with guided setup progress, named "Office requests" (or -2, -3 when taken). */
export const startOfficeSetup = (email: string, language: Language = "en") => startGuided("office-requests", { step: "name", answers: defaultAnswers(email, language) });
/** The purchase request template (roadmap phase 5): the owner is the first suggested approver and purchasing address. */
export const startPurchaseSetup = (email: string, language: Language = "en") => startGuided("purchase-requests", { template: PURCHASE_REQUEST, step: "name", answers: defaultPurchaseAnswers(email, language) });

type Start = { template?: string; step: string; answers: { name: string } };
// One start at a time: a second click while the first is still creating the draft joins it instead of making another.
let starting: Promise<void> | null = null;
const startGuided = (slug: string, setup: Start) => (starting ??= createOrResume(slug, setup).finally(() => (starting = null)));

async function createOrResume(slug: string, setup: Start) {
  // A second click, or coming back later, reopens the unfinished draft instead of adding another.
  const draft = newestDraft(await api<Workflow[]>("GET", "/workflows"), setup.template ?? OFFICE_REQUEST);
  if (draft) {
    location.hash = `#/a/${draft.id}`;
    return;
  }
  for (let n = 1; n <= 20; n++) {
    try {
      const wf = await api<Workflow>("POST", "/workflows", { name: setup.answers.name, slug: n === 1 ? slug : `${slug}-${n}` });
      await api("PATCH", `/workflows/${wf.id}/setup`, setup);
      location.hash = `#/a/${wf.id}`;
      return;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) throw err;
    }
  }
  throw new Error("Rename one of your automations of this kind and try again.");
}

const back = <a href="#/automations"><Text>Automations</Text></a>;

/** The sample run with no side effects: everything below is worked out in the browser (Doop frame TXcO7tiI-c). */
export function TryOfficeRequest({ email }: { email: string }) {
  const { language, t } = useLanguage();
  const [form, setForm] = useState({ name: SAMPLE_REQUEST.name, email: SAMPLE_REQUEST.email, summary: SAMPLE_REQUEST.summary, details: SAMPLE_REQUEST.details });
  const [shown, setShown] = useState<typeof form | null>(null);
  const [error, setError] = useState("");
  // One start at a time: startOfficeSetup joins a start already running, and the button waits for it.
  const [starting, setStarting] = useState(false);
  const field = (key: keyof typeof form, label: string, max: number, props: { type?: string; multiline?: boolean } = {}) => (
    <div className="gp-field">
      <label htmlFor={`try-${key}`}>{t(label)}</label>
      {props.multiline ? (
        <textarea id={`try-${key}`} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} maxLength={max} />
      ) : (
        <input id={`try-${key}`} type={props.type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} required maxLength={max} />
      )}
    </div>
  );
  const p = shown ? previewOfficeRequest(defaultAnswers("office@example.com", language), { ...SAMPLE_REQUEST, ...shown }, language) : null;

  return (
    <main className="page ops gp motion-page">
      <header className="ops-head">
        <div className="gp-title">
          <Breadcrumb items={[{ label: t("Library"), href: "#/new" }, { label: t("Preview an office request") }]} />
          <h1><Text>Preview an office request</Text></h1>
        </div>
        <span className="gp-tag"><Text>Preview only</Text></span>
      </header>
      <div className="ops-layout">
        <form
          className="ops-main"
          onSubmit={(e) => {
            e.preventDefault();
            setShown(form);
          }}
        >
          <div className="gp-section">
            <h2><Text>Sample request form</Text></h2>
            <p className="gp-lead"><Text>Use the example to see what the office and requester would receive. Nothing is sent and no request is recorded.</Text></p>
          </div>
          <div className="gp-fields">
            {field("name", "Requester name", 200)}
            {field("email", "Email", 254, { type: "email" })}
            {field("summary", "Subject", 500)}
            {field("details", "Request details", 2000, { multiline: true })}
          </div>
          <div className="gp-actions">
            <button className="ops-button"><Text>Try with sample details</Text></button>
            <button
              type="button"
              className="ops-button blue"
              disabled={starting}
              onClick={() => {
                setStarting(true);
                setError("");
                startOfficeSetup(email, language).catch((e: Error) => {
                  setError(e.message);
                  setStarting(false);
                });
              }}
            >
              {t("Use this template")}
            </button>
          </div>
          <p role="alert" className="gp-error" hidden={!error}>
            {error}
          </p>
        </form>

        <section className="ops-panel" aria-label={t("Preview result")}>
          <p className="gp-eyebrow"><Text>Sample result</Text></p>
          {p ? (
            <>
              <h2><Text>Office request received</Text></h2>
              <p className="gp-lead"><Text>This preview uses sample data. It sends no emails and adds no rows.</Text></p>
              <dl className="gp-facts">
                <div>
                  <dt><Text>Reference</Text></dt>
                  <dd>{p.reference}</dd>
                </div>
                <div>
                  <dt><Text>Request list</Text></dt>
                  <dd>{p.record.list}</dd>
                </div>
                <div>
                  <dt><Text>Office notification</Text></dt>
                  <dd>{p.notification.to}</dd>
                </div>
                <div>
                  <dt><Text>Requester receipt</Text></dt>
                  <dd>{p.receipt.to}</dd>
                </div>
              </dl>
              <Message title={t("Notification to the office")} mail={p.notification} />
              <Message title={t("Receipt to the employee")} mail={p.receipt} />
              {p.sheetRow && (
                <>
                  <h3><Text>Row added to your Google Sheet</Text></h3>
                  <pre>{p.sheetRow.join(" | ")}</pre>
                </>
              )}
              {p.slackMessage && (
                <>
                  <h3><Text>Note posted to your Slack channel</Text></h3>
                  <pre>{p.slackMessage}</pre>
                </>
              )}
            </>
          ) : (
            <>
              <h2><Text>Nothing sent yet</Text></h2>
              <p className="gp-lead"><Text>Choose Try with sample details to see the request, the office notification and the receipt this template would produce.</Text></p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function PreviewResult({ answers, sample }: { answers: OfficeRequestAnswers; sample: Record<string, string> }) {
  const { language } = useLanguage();
  const { t } = useLanguage();
  const p = previewOfficeRequest(answers, sample, language);
  return (
    <section aria-label={t("Preview result")}>
      <h2><Text>What would happen (preview only)</Text></h2>
      <p>
        {t("Sample reference:")} <strong>{p.reference}</strong>
      </p>
      <h3>{t("Row in {list}", { list: p.record.list })}</h3>
      <p>
        {p.record.reference}, {p.record.subject}, open
      </p>
      <Message title={t("Notification to the office")} mail={p.notification} />
      <Message title={t("Receipt to the employee")} mail={p.receipt} />
      {p.sheetRow && (
        <>
          <h3><Text>Row added to your Google Sheet</Text></h3>
          <pre>{p.sheetRow.join(" | ")}</pre>
        </>
      )}
      {p.slackMessage && (
        <>
          <h3><Text>Note posted to your Slack channel</Text></h3>
          <pre>{p.slackMessage}</pre>
        </>
      )}
    </section>
  );
}

function Message({ title, mail }: { title: string; mail: { to: string; subject: string; text: string } }) {
  const { t } = useLanguage();
  return (
    <>
      <h3>{title}</h3>
      <p className="muted">
        {t("To {to}. Subject: {subject}", { to: mail.to, subject: mail.subject })}
      </p>
      <pre>{mail.text}</pre>
    </>
  );
}

/** #/a/<id>: guided setup until the automation is turned on, then its status, form link and requests. */
export function OfficeRequestPage({ id }: { id: string }) {
  const [wf, setWf] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [editingSetup, setEditingSetup] = useState(false);
  const load = () => api<Detail>("GET", `/workflows/${id}`).then(setWf, (e: Error) => setError(e.message));
  useEffect(() => {
    setEditingSetup(false);
    void load();
  }, [id]);
  if (error) return <main className="page request-page guided-request">{back}<p role="alert" className="message error">{error}</p></main>;
  if (!wf) return <main className="page request-page guided-request" />;
  const setup = wf.setup as Setup | PurchaseSetup | GeneratedSetup | null;
  if (setup && !("kind" in setup)) {
    if (wf.live && wf.trigger) return <LivePage wf={wf} formId={wf.trigger.id} />;
    return setup.template === PURCHASE_REQUEST ? <PurchaseWizard wf={wf} setup={setup} onLive={load} /> : <SetupWizard wf={wf} setup={setup} onLive={load} />;
  }
  if (wf.live && !editingSetup) {
    return <AutomationStatusPage wf={wf} onReload={load} onEditSetup={() => setEditingSetup(true)} />;
  }
  const genSetup = setup && "kind" in setup && setup.kind === "generated" ? setup : null;
  return (
    <GeneratedWizard
      wf={wf}
      setup={genSetup}
      onDone={async () => {
        setEditingSetup(false);
        await load();
      }}
      onCancelEdit={wf.live ? () => setEditingSetup(false) : undefined}
    />
  );
}

/** What the side panel of a guided setup says about each step, and its footnote. */
type Side<S extends string> = { labels: Record<S, string>; note: string };

/**
 * The parts both guided setups share: answers saved at every step, Save and finish later, and Turn on, which publishes
 * the definition built from the answers. The API refuses Turn on while a connection or the named approver is missing.
 * The page follows the Doop frames rBZ4Ixi2bD and BXrDhLPy_-: step counter and bar, the form, and the setup steps beside it.
 */
function useWizard<S extends string, A extends { name: string }>(wf: Detail, steps: readonly S[], start: S, initial: A, template: string | undefined, definition: (a: A) => WorkflowDefinition, onLive: () => Promise<void>, side: Side<S>) {
  const { t } = useLanguage();
  const [step, setStep] = useState<S>(start);
  const [answers, setAnswers] = useState(initial);
  const [error, setError] = useState("");
  // One save at a time: a fast double click must not run Next twice, publish two versions or step back over saved answers.
  const [busy, setBusy] = useState(false);
  const index = steps.indexOf(step);
  const save = async (next: S) => {
    setError("");
    try {
      await api("PATCH", `/workflows/${wf.id}/setup`, { ...(template ? { template } : {}), step: next, answers });
      if (answers.name !== wf.name) await api("PATCH", `/workflows/${wf.id}`, { name: answers.name });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (index < steps.length - 1) {
        if (await save(steps[index + 1]!)) setStep(steps[index + 1]!);
        return;
      }
      if (!(await save(step))) return;
      try {
        await api("POST", `/workflows/${wf.id}/versions`, { definition: definition(answers), publish: true });
        await onLive();
      } catch (err) {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };
  const later = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (await save(step)) location.hash = "#/automations";
    } finally {
      setBusy(false);
    }
  };
  const edit = (to: S, what: string) => (
    <button type="button" className="ops-link" aria-label={`${t("Edit")}: ${t(what)}`} onClick={() => setStep(to)}>
      {t("Edit")}
    </button>
  );
  const frame = (stepTitle: string, body: ReactNode) => {
    const states = stepStates(steps.length, index);
    return (
      <main className="page ops gp motion-page">
        <header className="ops-head">
          <div className="gp-title">
            <h1>{wf.name}</h1>
          </div>
          <span className="gp-tag"><Text>Draft</Text></span>
        </header>
        <div className="ops-layout">
          <form className="ops-main" onSubmit={(e) => void onSubmit(e)}>
            <p id="request-step" className="gp-eyebrow">
              {t("Step {step} of {total}", { step: index + 1, total: steps.length })}
            </p>
            <div className="gp-bar" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={index + 1} aria-labelledby="request-step">
              {steps.map((s, i) => (
                <i key={s} data-done={i <= index ? "" : undefined} />
              ))}
            </div>
            <h2>{t(stepTitle)}</h2>
            <div className="gp-body">{body}</div>
            <p role="alert" className="gp-error" hidden={!error}>
              {error}
            </p>
            <div className="gp-actions">
              <button className={`ops-button ${index === steps.length - 1 ? "blue" : "dark"}`} disabled={busy}>
                {busy ? t("Saving…") : index === steps.length - 1 ? t("Turn on") : t("Next")}
              </button>
              <button type="button" className="ops-button" disabled={busy} onClick={() => void later()}>
                {t("Save and finish later")}
              </button>
            </div>
            {index > 0 && (
              <div className="gp-actions">
                <button type="button" className="ops-button" disabled={busy} onClick={() => setStep(steps[index - 1]!)}>
                  {t("Back")}
                </button>
              </div>
            )}
          </form>
          <aside className="ops-panel" aria-labelledby="setup-steps">
            <p id="setup-steps" className="gp-eyebrow"><Text>Setup steps</Text></p>
            <h2>{wf.name}</h2>
            <ol className="gp-steps">
              {steps.map((s, i) => (
                <li key={s} aria-current={states[i] === "current" ? "step" : undefined}>
                  <b aria-hidden="true">{i + 1}</b>
                  <strong>{t(side.labels[s])}</strong>
                  <span>{t(states[i] === "complete" ? "Complete" : states[i] === "current" ? "Current step" : "Upcoming")}</span>
                </li>
              ))}
            </ol>
            <p className="gp-note">{t(side.note)}</p>
          </aside>
        </div>
      </main>
    );
  };
  return { step, answers, setAnswers, edit, frame };
}

/** The review step: one row per setting, each with a way back to the step that sets it. */
function ReviewTable({ rows }: { rows: { label: string; value: ReactNode; edit?: ReactNode }[] }) {
  const { t } = useLanguage();
  return (
    <table className="ops-table gp-review">
      <thead>
        <tr>
          <th scope="col"><Text>Setting</Text></th>
          <th scope="col"><Text>Selected value</Text></th>
          <th scope="col"><span className="ops-sr"><Text>Change</Text></span></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row">{t(r.label)}</th>
            <td>{r.value}</td>
            <td className="c-edit">{r.edit}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const STEP_TITLES: Record<Step, string> = { name: "Name", fields: "Fields staff fill in", destinations: "Where requests and alerts go", review: "Review and turn on" };
const STEP_LABELS: Record<Step, string> = { name: "Name", fields: "Form fields", destinations: "Destinations", review: "Review and turn on" };

function SetupWizard({ wf, setup, onLive }: { wf: Detail; setup: Setup; onLive: () => Promise<void> }) {
  const { language, t } = useLanguage();
  const { step, answers, setAnswers, edit, frame } = useWizard(wf, SETUP_STEPS, setup.step, setup.answers, undefined, (a) => officeRequestDefinition(a, language), onLive, { labels: STEP_LABELS, note: "Work saved after each completed step." });
  const extra = (f: "location" | "details", on: boolean) =>
    setAnswers({ ...answers, extraFields: (["location", "details"] as const).filter((x) => (x === f ? on : answers.extraFields.includes(x))) });
  const apps = [answers.sheets && t("Google Sheets"), answers.slack && t("Slack")].filter(Boolean).join(", ");

  return frame(
    STEP_TITLES[step],
    <>
      {step === "name" && (
        <div className="gp-field">
          <label htmlFor="setup-name"><Text>Automation name</Text></label>
          <input id="setup-name" value={answers.name} onChange={(e) => setAnswers({ ...answers, name: e.target.value })} required maxLength={200} />
        </div>
      )}
      {step === "fields" && (
        <fieldset className="gp-fieldset">
          <legend><Text>Staff always give their name, their email and what needs attention. Also ask:</Text></legend>
          <label className="gp-check">
            <input type="checkbox" checked={answers.extraFields.includes("location")} onChange={(e) => extra("location", e.target.checked)} />
            {t("Where is it?")}
          </label>
          <label className="gp-check">
            <input type="checkbox" checked={answers.extraFields.includes("details")} onChange={(e) => extra("details", e.target.checked)} />
            {t("Anything else we should know?")}
          </label>
        </fieldset>
      )}
      {step === "destinations" && (
        <>
          <p className="gp-hint">{t("Requests are saved to the request list of {name} in kymavo.", { name: answers.name })}</p>
          <div className="gp-field">
            <label htmlFor="setup-notify"><Text>Send the office notification to</Text></label>
            <input id="setup-notify" type="email" value={answers.notifyEmail} onChange={(e) => setAnswers({ ...answers, notifyEmail: e.target.value })} required maxLength={254} />
          </div>
          <fieldset className="gp-fieldset">
            <legend><Text>Also send each request to (optional)</Text></legend>
            <label className="gp-check">
              <input type="checkbox" checked={answers.sheets ?? false} onChange={(e) => setAnswers({ ...answers, sheets: e.target.checked })} /> {t("A row in your Google Sheet")}
            </label>
            <label className="gp-check">
              <input type="checkbox" checked={answers.slack ?? false} onChange={(e) => setAnswers({ ...answers, slack: e.target.checked })} /> {t("A short note in your Slack channel (reference and subject only)")}
            </label>
            <p className="gp-hint">
              <Text>Connect them and pick the sheet and channel in</Text> <a href="#/apps"><Text>Apps</Text></a><Text>. Turning on checks that they are connected.</Text>
            </p>
          </fieldset>
        </>
      )}
      {step === "review" && (
        <>
          <p className="gp-callout"><Text>New submissions will create a request and send a receipt.</Text></p>
          <ReviewTable
            rows={[
              { label: "Request list", value: answers.name, edit: edit("name", "Request list") },
              {
                label: "Request form",
                value: [t("Name"), t("Email"), t("What needs attention?"), answers.extraFields.includes("location") && t("Where is it?"), answers.extraFields.includes("details") && t("Anything else we should know?")].filter(Boolean).join(", "),
                edit: edit("fields", "Request form"),
              },
              { label: "Office inbox", value: answers.notifyEmail, edit: edit("destinations", "Office inbox") },
              { label: "Receipt to the requester", value: t("Receipt with the request reference") },
              { label: "Optional apps", value: apps || t("None"), edit: edit("destinations", "Optional apps") },
            ]}
          />
          <MailNotice />
          <p className="gp-hint"><Text>Email goes out through the mail server in this installation's settings. A local demo delivers it to Mailpit.</Text></p>
          <details className="gp-details">
            <summary><Text>Example messages</Text></summary>
            <PreviewResult answers={answers} sample={SAMPLE_REQUEST} />
          </details>
        </>
      )}
    </>,
  );
}

type Member = { userId: string; email: string; role: string };
const PURCHASE_TITLES: Record<(typeof PURCHASE_SETUP_STEPS)[number], string> = { name: "Name", approver: "Who decides", destinations: "Where approved requests go", review: "Review and turn on" };
const PURCHASE_LABELS: Record<(typeof PURCHASE_SETUP_STEPS)[number], string> = { name: "Name", approver: "Approval", destinations: "Destinations", review: "Review and turn on" };

/** Purchase request with a named approver (roadmap phase 5): the Microsoft office template, Outlook and Teams optional. */
function PurchaseWizard({ wf, setup, onLive }: { wf: Detail; setup: PurchaseSetup; onLive: () => Promise<void> }) {
  const { language, t } = useLanguage();
  const { step, answers, setAnswers, edit, frame } = useWizard<(typeof PURCHASE_SETUP_STEPS)[number], PurchaseRequestAnswers>(
    wf,
    PURCHASE_SETUP_STEPS,
    setup.step,
    setup.answers,
    PURCHASE_REQUEST,
    (a) => purchaseRequestDefinition(a, language),
    onLive,
    { labels: PURCHASE_LABELS, note: "Only eligible workspace members can be named as approvers." },
  );
  // Only the owner and members with the approver role may decide (decision 0022).
  const [approvers, setApprovers] = useState<Member[] | null>(null);
  useEffect(() => void api<Member[]>("GET", "/workspace/members").then((m) => setApprovers(m.filter((x) => x.role === "owner" || x.role === "approver")), () => setApprovers([])), []);
  const preview = previewPurchaseRequest(answers, SAMPLE_PURCHASE, language);
  const approval = preview.messages.find((m) => m.via === "kymavo approval link");

  return frame(
    PURCHASE_TITLES[step],
    <>
      {step === "name" && (
        <div className="gp-field">
          <label htmlFor="setup-name"><Text>Automation name</Text></label>
          <input id="setup-name" value={answers.name} onChange={(e) => setAnswers({ ...answers, name: e.target.value })} required maxLength={200} />
        </div>
      )}
      {step === "approver" && (
        <>
          <p className="gp-hint"><Text>Choose the reviewer who must decide before the request goes to purchasing.</Text></p>
          <div className="gp-field">
            <label htmlFor="setup-approver"><Text>Who approves purchases</Text></label>
            <select id="setup-approver" value={answers.approver} onChange={(e) => setAnswers({ ...answers, approver: e.target.value })} required>
              {approvers?.map((m) => (
                <option key={m.userId} value={m.email}>
                  {m.email} ({m.role})
                </option>
              ))}
            </select>
          </div>
          <div className="gp-callout">
            <strong>{t("What {approver} receives", { approver: answers.approver })}</strong>
            <span><Text>The request reference, item, cost and requester's notes, with a link to approve or reject.</Text></span>
          </div>
          {approval && (
            <details className="gp-details">
              <summary><Text>Preview the approval email</Text></summary>
              <Message title={`${t(approval.title)} (${t(approval.via)})`} mail={approval} />
            </details>
          )}
          <p className="gp-hint">
            <Text>Only this person can approve or reject, signed in to kymavo. A forwarded link does not work for anyone else. To add someone, invite them as an approver on the</Text>{" "}
            <a href="#/team"><Text>Team</Text></a> <Text>page.</Text>
          </p>
        </>
      )}
      {step === "destinations" && (
        <>
          <div className="gp-field">
            <label htmlFor="setup-purchasing"><Text>Send approved requests to (purchasing)</Text></label>
            <input id="setup-purchasing" type="email" value={answers.purchasingEmail} onChange={(e) => setAnswers({ ...answers, purchasingEmail: e.target.value })} required maxLength={254} />
          </div>
          <fieldset className="gp-fieldset">
            <legend><Text>Microsoft 365 (optional)</Text></legend>
            <label className="gp-check">
              <input type="checkbox" checked={answers.outlook ?? false} onChange={(e) => setAnswers({ ...answers, outlook: e.target.checked })} /> {t("Send the emails from our Outlook mailbox")}
            </label>
            <label className="gp-check">
              <input type="checkbox" checked={answers.teams ?? false} onChange={(e) => setAnswers({ ...answers, teams: e.target.checked })} /> {t("Post a note in our Teams channel when a purchase is approved (reference and item only)")}
            </label>
            <p className="gp-hint">
              <Text>Connect them in</Text> <a href="#/apps"><Text>Apps</Text></a><Text>. Turning on checks that they are connected.</Text> Your organization may need an administrator to
              approve Outlook or the Teams Workflows app; that page says how.
            </p>
          </fieldset>
        </>
      )}
      {step === "review" && (
        <>
          <p className="gp-callout">{t("New submissions will ask {approver} to approve or reject, signed in to kymavo.", { approver: answers.approver })}</p>
          <ReviewTable
            rows={[
              { label: "Request list", value: answers.name, edit: edit("name", "Request list") },
              { label: "Approver", value: answers.approver, edit: edit("approver", "Approver") },
              { label: "Purchasing inbox", value: answers.purchasingEmail + (answers.teams ? t(" and a Teams note") : ""), edit: edit("destinations", "Purchasing inbox") },
              { label: "Emails sent from", value: answers.outlook ? t("Your connected Outlook mailbox") : t("The mail server in this installation's settings"), edit: edit("destinations", "Emails sent from") },
              { label: "If rejected, or no decision in a week", value: t("The employee is told") },
            ]}
          />
          <MailNotice />
          <p className="gp-hint">{t("The approval request carries a sign-in link and goes out through the email sender on Apps. A Teams note never approves anything.")}</p>
          <details className="gp-details">
            <summary><Text>Example messages</Text></summary>
            <p>
              <Text>Sample reference:</Text> <strong>{preview.reference}</strong>
            </p>
            {preview.messages.map((m) => (
              <Message key={m.title} title={`${t(m.title)} (${t(m.via)})`} mail={m} />
            ))}
            {preview.teamsMessage && (
              <>
                <h3><Text>Note in your Teams channel, once approved</Text></h3>
                <pre>{preview.teamsMessage}</pre>
              </>
            )}
          </details>
        </>
      )}
    </>,
  );
}

const OUTCOME_TAG: Record<RequestKind, string> = { done: "ok", failed: "bad", waiting: "wait", sending: "", slow: "bad" };

/** The status text of a request. "Stopped", not "Not sent": earlier steps of a failed run may already have sent something (Details shows each step). */
const outcome = (kind: RequestKind, done: string) =>
  kind === "done" ? done : kind === "failed" ? "Stopped, open details" : kind === "waiting" ? "Waiting for a decision" : kind === "slow" ? `Sending. ${TAKING_LONGER}` : "Sending";

/** #/a/<id> once the automation is on (Doop frame HofpINHSRv): the form link, the figures, the requests and the selected request's deliveries. */
function LivePage({ wf, formId }: { wf: Detail; formId: string }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [copied, setCopied] = useState("");
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // On a phone the selected request opens as a sheet over the list; on a desktop its panel is always there.
  const [sheet, setSheet] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openedFrom = useRef<HTMLElement | null>(null);
  const load = () =>
    api<RequestRow[]>("GET", `/workflows/${wf.id}/requests`).then(
      (r) => {
        setFailed(false);
        setRows(r);
      },
      () => setFailed(true),
    );
  useEffect(() => void load(), [wf.id]);
  useEffect(() => {
    if (!sheet) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeSheet();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet]);
  const closeSheet = () => {
    setSheet(false);
    openedFrom.current?.focus();
  };
  const link = `${location.origin}/forms/${formId}`;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const copy = () =>
    navigator.clipboard.writeText(link).then(
      () => setCopied(t("Form link copied.")),
      () => setCopied(t("Copy this link: {link}", { link })),
    );
  const purchase = (wf.setup as { template?: string } | null)?.template === PURCHASE_REQUEST;
  const selected = rows?.find((r) => r.id === selectedId) ?? rows?.[0];
  const counts = requestCounts(rows ?? []);

  return (
    <main className="page ops gp gp-live motion-page">
      <header className="ops-head">
        <div className="gp-title">
          <h1>{wf.name}</h1>
        </div>
        <p role="status" className="gp-status">
          <span className="gp-tag ok">{t("Accepting requests")}</span> {copied}
        </p>
      </header>
      <AutomationTabs id={wf.id} here="overview" overview />
      <div className="ops-layout">
        <div className="ops-main">
          <MailNotice />
          <section className="gp-card" aria-labelledby="form-link">
            <h2 id="form-link"><Text>Request form</Text></h2>
            <p className="gp-hint">
              {t("Form link:")} <code>{link}</code>
            </p>
            {local && <p className="gp-hint"><Text>This link works on this computer only. To share the form with staff, run kymavo on an address they can reach.</Text></p>}
            <div className="gp-actions">
              <button type="button" className="ops-button blue" onClick={() => void copy()}>
                {t("Copy form link")}
              </button>
              <FormEmbed link={link} />
              <a className="ops-button" href={link} target="_blank" rel="noreferrer">
                {t("Open form")}
              </a>
            </div>
          </section>

          <div className="ops-head">
            <h2><Text>Requests</Text></h2>
            <div className="ops-actions">
              <button type="button" className="ops-button" onClick={() => void load()}>
                {t("Refresh")}
              </button>
              <a className="ops-button" href={`#/w/${wf.id}/runs`}>
                {t("View activity")}
              </a>
            </div>
          </div>
          {failed ? (
            <p role="alert" className="gp-error">
              {t("Couldn't load.")} <button type="button" className="ops-link" onClick={() => void load()}><Text>Retry</Text></button>
            </p>
          ) : rows === null ? (
            <p className="gp-hint"><Text>Loading…</Text></p>
          ) : (
            <>
              <div className="ops-kpis">
                <div>
                  <span><Text>Received today</Text></span>
                  <b>{counts.today}</b>
                </div>
                <div>
                  <span><Text>Waiting</Text></span>
                  <b>{counts.waiting}</b>
                </div>
                <div>
                  <span><Text>Completed</Text></span>
                  <b>{counts.completed}</b>
                </div>
              </div>
              {rows.length === 0 ? (
                <p className="gp-hint"><Text>No requests yet. Open the form and send one.</Text></p>
              ) : (
                <table className="ops-table gp-requests">
                  <thead>
                    <tr>
                      <th scope="col"><Text>Reference</Text></th>
                      <th scope="col"><Text>Request</Text></th>
                      <th scope="col"><Text>Received</Text></th>
                      <th scope="col"><Text>Delivery</Text></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const kind = requestKind(r);
                      const attention = needsAttention(r.deliveries);
                      return (
                        <tr
                          key={r.id}
                          className="ops-row"
                          data-selected={r.id === selected?.id ? "" : undefined}
                          onClick={(e) => {
                            setSelectedId(r.id);
                            setSheet(true);
                            openedFrom.current = e.currentTarget.querySelector("button");
                          }}
                        >
                          <td data-label={t("Reference")} className="c-ref">
                            <button type="button" aria-pressed={r.id === selected?.id}>{r.reference}</button>
                          </td>
                          <td data-label={t("Request")} className="c-req">{r.subject}</td>
                          <td data-label={t("Received")} className="c-when">{new Date(r.createdAt).toLocaleString()}</td>
                          <td data-label={t("Delivery")} className="c-state">
                            <span className={`gp-tag ${attention ? "bad" : OUTCOME_TAG[kind]}`}>{t(outcome(kind, purchase ? "Finished" : "Processed"))}</span>
                            {attention && <span className="gp-sub">{t("A delivery needs attention")}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>

        {selected && (
          <>
            {sheet && <div className="ops-backdrop" onClick={closeSheet} />}
            <aside className="ops-panel" aria-label={t("Selected request")} data-sheet={sheet ? "" : undefined}>
              <div className="panel-top">
                <p className="gp-eyebrow"><Text>Selected request</Text></p>
                <button type="button" className="panel-close" ref={closeRef} onClick={closeSheet}>
                  {t("Close")}
                </button>
              </div>
              <h2>{selected.reference}</h2>
              <p className="gp-lead">{selected.subject}</p>
              <dl className="gp-facts">
                <div>
                  <dt><Text>Received</Text></dt>
                  <dd>{new Date(selected.createdAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt><Text>Progress</Text></dt>
                  <dd>{t(outcome(requestKind(selected), purchase ? "Finished" : "Processed"))}</dd>
                </div>
              </dl>
              <h3><Text>Deliveries</Text></h3>
              {selected.deliveries.length ? <DeliveryList deliveries={selected.deliveries} onChange={load} /> : <p className="gp-hint">{t("None")}</p>}
              <a className="gp-link" href={`#/runs/${selected.runId}`}>
                {t("See run history")}
              </a>
            </aside>
          </>
        )}
      </div>
    </main>
  );
}
