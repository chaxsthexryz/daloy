import "./automations-ops.css";
import "./guided-pages.css";
import "./request-access.css";
import { Text } from "./Language";
import { useLanguage } from "./Language";
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
  type Setup,
  type WorkflowDefinition,
} from "@daloy/engine";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type Workflow } from "./api";
import { FormEmbed } from "./FormEmbed";
import { DeliveryList, type Delivery } from "./Connections";
import { newestDraft } from "./lib/drafts";
import { takingLonger } from "./lib/poll";
import { MailNotice } from "./MailNotice";
import { AutomationTabs } from "./Nav";
import { TAKING_LONGER } from "./Runs";

type Step = (typeof SETUP_STEPS)[number];
type Detail = Omit<Workflow, "live"> & { trigger: { id: string } | null; live: unknown };
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

const back = <a href="#/"><Text>Automations</Text></a>;

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
          <p className="gp-crumb">
            <a href="#/"><Text>Automations</Text></a> / <a href="#/new"><Text>New automation</Text></a>
          </p>
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
  const load = () => api<Detail>("GET", `/workflows/${id}`).then(setWf, (e: Error) => setError(e.message));
  useEffect(() => void load(), [id]);
  if (error) return <main className="page request-page guided-request">{back}<p role="alert" className="message error">{error}</p></main>;
  if (!wf) return <main className="page request-page guided-request" />;
  const setup = wf.setup as Setup | PurchaseSetup | null;
  if (!setup) return <main className="page request-page guided-request">{back}<p><Text>This workflow has no guided setup.</Text> <a href={`#/w/${id}`}><Text>Open advanced editor</Text></a></p></main>;
  if (wf.live && wf.trigger) return <LivePage wf={wf} formId={wf.trigger.id} />;
  return setup.template === PURCHASE_REQUEST ? <PurchaseWizard wf={wf} setup={setup} onLive={load} /> : <SetupWizard wf={wf} setup={setup as Setup} onLive={load} />;
}

/**
 * The parts both guided setups share: answers saved at every step, Save and finish later, and Turn on, which publishes
 * the definition built from the answers. The API refuses Turn on while a connection or the named approver is missing.
 */
function useWizard<S extends string, A extends { name: string }>(wf: Detail, steps: readonly S[], start: S, initial: A, template: string | undefined, definition: (a: A) => WorkflowDefinition, onLive: () => Promise<void>) {
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
      if (await save(step)) location.hash = "#/";
    } finally {
      setBusy(false);
    }
  };
  const edit = (to: S) => (
    <button type="button" className="quiet" onClick={() => setStep(to)}>
      {t("Edit")}
    </button>
  );
  const frame = (title: string, stepTitle: string, body: ReactNode) => (
    <main className="page request-page guided-request">
      <p>{back}</p>
      <h1>{t("Set up: {title}", { title: t(title) })}</h1>
      <p id="request-step" className="muted">
        {t("Step {step} of {total}: {title}. Your answers are saved at each step.", { step: index + 1, total: steps.length, title: t(stepTitle) })}
      </p>
      <progress className="request-progress" value={index + 1} max={steps.length} aria-labelledby="request-step" />
      <form className="create" onSubmit={(e) => void onSubmit(e)}>
        <h2>{t(stepTitle)}</h2>
        {body}
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
        <div className="actions">
          {index > 0 && (
            <button type="button" className="quiet" disabled={busy} onClick={() => setStep(steps[index - 1]!)}>
              {t("Back")}
            </button>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : index === steps.length - 1 ? "Turn on" : "Next"}
          </button>
          <button type="button" className="quiet" disabled={busy} onClick={() => void later()}>
            {t("Save and finish later")}
          </button>
        </div>
      </form>
    </main>
  );
  return { step, answers, setAnswers, edit, frame };
}

const STEP_TITLES: Record<Step, string> = { name: "Name", fields: "Fields staff fill in", destinations: "Where requests and alerts go", review: "Review" };

function SetupWizard({ wf, setup, onLive }: { wf: Detail; setup: Setup; onLive: () => Promise<void> }) {
  const { language, t } = useLanguage();
  const { step, answers, setAnswers, edit, frame } = useWizard(wf, SETUP_STEPS, setup.step, setup.answers, undefined, (a) => officeRequestDefinition(a, language), onLive);
  const extra = (f: "location" | "details", on: boolean) =>
    setAnswers({ ...answers, extraFields: (["location", "details"] as const).filter((x) => (x === f ? on : answers.extraFields.includes(x))) });

  return frame(
    "Track an office request",
    STEP_TITLES[step],
    <>
        {step === "name" && (
          <div className="field">
            <label htmlFor="setup-name"><Text>Automation name</Text></label>
            <input id="setup-name" value={answers.name} onChange={(e) => setAnswers({ ...answers, name: e.target.value })} required maxLength={200} />
          </div>
        )}
        {step === "fields" && (
          <fieldset>
            <legend><Text>Staff always give their name, their email and what needs attention. Also ask:</Text></legend>
            <label className="check">
              <input type="checkbox" checked={answers.extraFields.includes("location")} onChange={(e) => extra("location", e.target.checked)} />
              {t("Where is it?")}
            </label>
            <label className="check">
              <input type="checkbox" checked={answers.extraFields.includes("details")} onChange={(e) => extra("details", e.target.checked)} />
              {t("Anything else we should know?")}
            </label>
          </fieldset>
        )}
        {step === "destinations" && (
          <>
            <p>{t("Requests are saved to the request list of {name} in Daloy.", { name: answers.name })}</p>
            <div className="field">
              <label htmlFor="setup-notify"><Text>Send the office notification to</Text></label>
              <input id="setup-notify" type="email" value={answers.notifyEmail} onChange={(e) => setAnswers({ ...answers, notifyEmail: e.target.value })} required maxLength={254} />
            </div>
            <fieldset>
              <legend><Text>Also send each request to (optional)</Text></legend>
              <label className="check">
                <input type="checkbox" checked={answers.sheets ?? false} onChange={(e) => setAnswers({ ...answers, sheets: e.target.checked })} /> {t("A row in your Google Sheet")}
              </label>
              <label className="check">
                <input type="checkbox" checked={answers.slack ?? false} onChange={(e) => setAnswers({ ...answers, slack: e.target.checked })} /> {t("A short note in your Slack channel (reference and subject only)")}
              </label>
              <p className="muted">
                <Text>Connect them and pick the sheet and channel in</Text> <a href="#/apps"><Text>Apps</Text></a><Text>. Turning on checks that they are connected.</Text>
              </p>
            </fieldset>
          </>
        )}
        {step === "review" && (
          <>
            <p><Text>When someone submits this form:</Text></p>
            <ul>
              <li>
                {t("Save each request to {name}.", { name: answers.name })} {edit("name")}
              </li>
              <li>
                {t("Ask for name, email, what needs attention")}{answers.extraFields.includes("location") && t(", where it is")}
                {answers.extraFields.includes("details") && t(", anything else")}. {edit("fields")}
              </li>
              <li>
                {t("Notify the office at {email}.", { email: answers.notifyEmail })} {edit("destinations")}
              </li>
              <li><Text>Send the employee a receipt with the request reference.</Text></li>
              {answers.sheets && <li>{t("Add a row to your Google Sheet, starting with the reference.")} {edit("destinations")}</li>}
              {answers.slack && <li>{t("Post the reference and subject to your Slack channel.")} {edit("destinations")}</li>}
            </ul>
            <MailNotice />
            <p className="muted"><Text>Email goes out through the mail server in this installation's settings. A local demo delivers it to Mailpit.</Text></p>
            <details>
              <summary><Text>Example messages</Text></summary>
              <PreviewResult answers={answers} sample={SAMPLE_REQUEST} />
            </details>
          </>
        )}
    </>,
  );
}

type Member = { userId: string; email: string; role: string };
const PURCHASE_TITLES: Record<(typeof PURCHASE_SETUP_STEPS)[number], string> = { name: "Name", approver: "Who decides", destinations: "Where approved requests go", review: "Review" };

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
  );
  // Only the owner and members with the approver role may decide (decision 0022).
  const [approvers, setApprovers] = useState<Member[] | null>(null);
  useEffect(() => void api<Member[]>("GET", "/workspace/members").then((m) => setApprovers(m.filter((x) => x.role === "owner" || x.role === "approver")), () => setApprovers([])), []);
  const preview = previewPurchaseRequest(answers, SAMPLE_PURCHASE, language);

  return frame(
    "Purchase request with a named approver",
    PURCHASE_TITLES[step],
    <>
      {step === "name" && (
        <div className="field">
          <label htmlFor="setup-name"><Text>Automation name</Text></label>
          <input id="setup-name" value={answers.name} onChange={(e) => setAnswers({ ...answers, name: e.target.value })} required maxLength={200} />
        </div>
      )}
      {step === "approver" && (
        <>
          <div className="field">
            <label htmlFor="setup-approver"><Text>Who approves purchases</Text></label>
            <select id="setup-approver" value={answers.approver} onChange={(e) => setAnswers({ ...answers, approver: e.target.value })} required>
              {approvers?.map((m) => (
                <option key={m.userId} value={m.email}>
                  {m.email} ({m.role})
                </option>
              ))}
            </select>
          </div>
          <p className="muted">
            <Text>Only this person can approve or reject, signed in to Daloy. A forwarded link does not work for anyone else. To add someone, invite them as an approver on the</Text>{" "}
            <a href="#/team"><Text>Team</Text></a> <Text>page.</Text>
          </p>
        </>
      )}
      {step === "destinations" && (
        <>
          <div className="field">
            <label htmlFor="setup-purchasing"><Text>Send approved requests to (purchasing)</Text></label>
            <input id="setup-purchasing" type="email" value={answers.purchasingEmail} onChange={(e) => setAnswers({ ...answers, purchasingEmail: e.target.value })} required maxLength={254} />
          </div>
          <fieldset>
            <legend><Text>Microsoft 365 (optional)</Text></legend>
            <label className="check">
              <input type="checkbox" checked={answers.outlook ?? false} onChange={(e) => setAnswers({ ...answers, outlook: e.target.checked })} /> {t("Send the emails from our Outlook mailbox")}
            </label>
            <label className="check">
              <input type="checkbox" checked={answers.teams ?? false} onChange={(e) => setAnswers({ ...answers, teams: e.target.checked })} /> {t("Post a note in our Teams channel when a purchase is approved (reference and item only)")}
            </label>
            <p className="muted">
              <Text>Connect them in</Text> <a href="#/apps"><Text>Apps</Text></a><Text>. Turning on checks that they are connected.</Text> Your organization may need an administrator to
              approve Outlook or the Teams Workflows app; that page says how.
            </p>
          </fieldset>
        </>
      )}
      {step === "review" && (
        <>
          <p><Text>When someone submits this form:</Text></p>
          <ul>
            <li>
              {t("Save the request to {name} with a reference, and send the employee a receipt.", { name: answers.name })} {edit("name")}
            </li>
            <li>
              {t("Ask {approver} to approve or reject it, signed in to Daloy.", { approver: answers.approver })} {edit("approver")}
            </li>
            <li>
              {t("If approved, email purchasing at {email}", { email: answers.purchasingEmail })}
              {answers.teams && t(" and post a note in your Teams channel")}{t(", then tell the employee.")} {edit("destinations")}
            </li>
            <li><Text>If rejected, or nobody decides within a week, tell the employee.</Text></li>
          </ul>
          <MailNotice />
          <p className="muted">
            {t(answers.outlook ? "Emails to the employee and to purchasing go out from your connected Outlook mailbox." : "Emails go out through the mail server in this installation's settings.")} {t("The approval request carries a sign-in link and goes out through the email sender on Apps. A Teams note never approves anything.")}
          </p>
          <details>
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

const outcome = (r: RequestRow, done: string) =>
  // "Stopped", not "Not sent": earlier steps of a failed run may already have sent something (Details shows each step).
  r.runState === "succeeded" ? done : r.runState === "failed" ? "Stopped, open details" : r.runState === "waiting" ? "Waiting for a decision" : takingLonger(r.createdAt) ? `Sending. ${TAKING_LONGER}` : "Sending";

function LivePage({ wf, formId }: { wf: Detail; formId: string }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [copied, setCopied] = useState("");
  const [failed, setFailed] = useState(false);
  const load = () =>
    api<RequestRow[]>("GET", `/workflows/${wf.id}/requests`).then(
      (r) => {
        setFailed(false);
        setRows(r);
      },
      () => setFailed(true),
    );
  useEffect(() => void load(), [wf.id]);
  const link = `${location.origin}/forms/${formId}`;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const copy = () =>
    navigator.clipboard.writeText(link).then(
      () => setCopied(t("Form link copied.")),
      () => setCopied(t("Copy this link: {link}", { link })),
    );

  return (
    <main className="page request-page guided-request">
      <p>{back}</p>
      <h1>{wf.name}</h1>
      <AutomationTabs id={wf.id} here="overview" overview />
      <p role="status">
        <span className="tag ok">{t("Accepting requests")}</span> {copied}
      </p>
      <MailNotice />
      <p>
        {t("Form link:")} <code>{link}</code>
      </p>
      {local && <p className="muted"><Text>This link works on this computer only. To share the form with staff, run Daloy on an address they can reach.</Text></p>}
      <div className="actions">
        <button type="button" className="primary" onClick={() => void copy()}>
          {t("Copy form link")}
        </button>
        <FormEmbed link={link} />
        <a href={link} target="_blank" rel="noreferrer">
          {t("Open form")}
        </a>
      </div>
      <h2><Text>Requests</Text></h2>
      <div className="actions">
        <button type="button" className="quiet" onClick={() => void load()}>
          {t("Refresh")}
        </button>
      </div>
      {failed ? (
        <p role="alert">{t("Couldn't load.")} <button type="button" onClick={() => void load()}><Text>Retry</Text></button></p>
      ) : rows === null ? (
        <p><Text>Loading…</Text></p>
      ) : rows.length === 0 ? (
        <p className="muted"><Text>No requests yet. Open the form and send one.</Text></p>
      ) : (
        <div className="table-wrap">
          <table className="table cards">
            <thead>
              <tr>
                <th scope="col"><Text>Reference</Text></th>
                <th scope="col"><Text>Subject</Text></th>
                <th scope="col"><Text>Received</Text></th>
                <th scope="col"><Text>Recorded in</Text></th>
                <th scope="col"><Text>Progress</Text></th>
                <th scope="col"><Text>Deliveries</Text></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label={t("Reference") }>{r.reference}</td>
                  <td data-label={t("Subject") }>{r.subject}</td>
                  <td data-label={t("Received") }>{new Date(r.createdAt).toLocaleString()}</td>
                  <td data-label={t("Recorded in") }>{wf.name}</td>
                  <td data-label={t("Progress") }>
                    {t(outcome(r, (wf.setup as { template?: string } | null)?.template === PURCHASE_REQUEST ? "Finished" : "Processed"))} <a href={`#/runs/${r.runId}`}><Text>Details</Text></a>
                  </td>
                  <td data-label={t("Deliveries") }>{r.deliveries.length ? <DeliveryList deliveries={r.deliveries} onChange={load} /> : <span className="muted">{t("None")}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
