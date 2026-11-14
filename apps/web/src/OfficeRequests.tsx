import {
  defaultAnswers,
  defaultPurchaseAnswers,
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
import { DeliveryList, type Delivery } from "./Connections";

type Step = (typeof SETUP_STEPS)[number];
type Detail = Omit<Workflow, "live"> & { trigger: { id: string } | null; live: unknown };
type RequestRow = { id: string; reference: string; subject: string; createdAt: string; runId: string; runState: string; runError: string | null; deliveries: Delivery[] };

/** "Set up for my office": a new workflow with guided setup progress, named "Office requests" (or -2, -3 when taken). */
export const startOfficeSetup = (email: string) => startGuided("office-requests", { step: "name", answers: defaultAnswers(email) });
/** The purchase request template (roadmap phase 5): the owner is the first suggested approver and purchasing address. */
export const startPurchaseSetup = (email: string) => startGuided("purchase-requests", { template: PURCHASE_REQUEST, step: "name", answers: defaultPurchaseAnswers(email) });

async function startGuided(slug: string, setup: { template?: string; step: string; answers: { name: string } }) {
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

const back = <a href="#/">Home</a>;

/** The sample run with no side effects: everything below is worked out in the browser. */
export function TryOfficeRequest({ email }: { email: string }) {
  const [summary, setSummary] = useState(SAMPLE_REQUEST.summary);
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState("");
  return (
    <main className="page">
      <p>{back}</p>
      <h1>Preview only</h1>
      <p className="muted">Try an example of Track an office request. Nothing is sent and no request is recorded.</p>
      <form
        className="create"
        onSubmit={(e) => {
          e.preventDefault();
          setShown(summary);
        }}
      >
        <h2>Sample form</h2>
        <p className="muted">
          {SAMPLE_REQUEST.name}, {SAMPLE_REQUEST.email}, {SAMPLE_REQUEST.location}
        </p>
        <div className="field">
          <label htmlFor="try-summary">What needs attention?</label>
          <input id="try-summary" value={summary} onChange={(e) => setSummary(e.target.value)} required maxLength={500} />
        </div>
        <div className="actions">
          <button className="primary">Try with sample details</button>
        </div>
      </form>
      {shown && <PreviewResult answers={defaultAnswers("office@example.com")} sample={{ ...SAMPLE_REQUEST, summary: shown }} />}
      <div className="actions">
        <button type="button" className="primary" onClick={() => startOfficeSetup(email).catch((e: Error) => setError(e.message))}>
          Set up for my office
        </button>
      </div>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </main>
  );
}

function PreviewResult({ answers, sample }: { answers: OfficeRequestAnswers; sample: Record<string, string> }) {
  const p = previewOfficeRequest(answers, sample);
  return (
    <section aria-label="Preview result">
      <h2>What would happen (preview only)</h2>
      <p>
        Sample reference: <strong>{p.reference}</strong>
      </p>
      <h3>Row in {p.record.list}</h3>
      <p>
        {p.record.reference}, {p.record.subject}, open
      </p>
      <Message title="Notification to the office" mail={p.notification} />
      <Message title="Receipt to the employee" mail={p.receipt} />
      {p.sheetRow && (
        <>
          <h3>Row added to your Google Sheet</h3>
          <pre>{p.sheetRow.join(" | ")}</pre>
        </>
      )}
      {p.slackMessage && (
        <>
          <h3>Note posted to your Slack channel</h3>
          <pre>{p.slackMessage}</pre>
        </>
      )}
    </section>
  );
}

function Message({ title, mail }: { title: string; mail: { to: string; subject: string; text: string } }) {
  return (
    <>
      <h3>{title}</h3>
      <p className="muted">
        To {mail.to}. Subject: {mail.subject}
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
  if (error) return <main className="page">{back}<p role="alert" className="message error">{error}</p></main>;
  if (!wf) return <main className="page" />;
  const setup = wf.setup as Setup | PurchaseSetup | null;
  if (!setup) return <main className="page">{back}<p>This workflow has no guided setup. <a href={`#/w/${id}`}>Open advanced editor</a></p></main>;
  if (wf.live && wf.trigger) return <LivePage wf={wf} formId={wf.trigger.id} />;
  return setup.template === PURCHASE_REQUEST ? <PurchaseWizard wf={wf} setup={setup} onLive={load} /> : <SetupWizard wf={wf} setup={setup as Setup} onLive={load} />;
}

/**
 * The parts both guided setups share: answers saved at every step, Save and finish later, and Turn on, which publishes
 * the definition built from the answers. The API refuses Turn on while a connection or the named approver is missing.
 */
function useWizard<S extends string, A extends { name: string }>(wf: Detail, steps: readonly S[], start: S, initial: A, template: string | undefined, definition: (a: A) => WorkflowDefinition, onLive: () => Promise<void>) {
  const [step, setStep] = useState<S>(start);
  const [answers, setAnswers] = useState(initial);
  const [error, setError] = useState("");
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
  };
  const later = async () => {
    if (await save(step)) location.hash = "#/";
  };
  const edit = (to: S) => (
    <button type="button" className="quiet" onClick={() => setStep(to)}>
      Edit
    </button>
  );
  const frame = (title: string, stepTitle: string, body: ReactNode) => (
    <main className="page">
      <p>{back}</p>
      <h1>Set up: {title}</h1>
      <p className="muted">
        Step {index + 1} of {steps.length}: {stepTitle}. Your answers are saved at each step.
      </p>
      <form className="create" onSubmit={(e) => void onSubmit(e)}>
        <h2>{stepTitle}</h2>
        {body}
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
        <div className="actions">
          {index > 0 && (
            <button type="button" className="quiet" onClick={() => setStep(steps[index - 1]!)}>
              Back
            </button>
          )}
          <button className="primary">{index === steps.length - 1 ? "Turn on" : "Next"}</button>
          <button type="button" className="quiet" onClick={() => void later()}>
            Save and finish later
          </button>
        </div>
      </form>
    </main>
  );
  return { step, answers, setAnswers, edit, frame };
}

const STEP_TITLES: Record<Step, string> = { name: "Name", fields: "Fields staff fill in", destinations: "Where requests and alerts go", review: "Review" };

function SetupWizard({ wf, setup, onLive }: { wf: Detail; setup: Setup; onLive: () => Promise<void> }) {
  const { step, answers, setAnswers, edit, frame } = useWizard(wf, SETUP_STEPS, setup.step, setup.answers, undefined, officeRequestDefinition, onLive);
  const extra = (f: "location" | "details", on: boolean) =>
    setAnswers({ ...answers, extraFields: (["location", "details"] as const).filter((x) => (x === f ? on : answers.extraFields.includes(x))) });

  return frame(
    "Track an office request",
    STEP_TITLES[step],
    <>
        {step === "name" && (
          <div className="field">
            <label htmlFor="setup-name">Automation name</label>
            <input id="setup-name" value={answers.name} onChange={(e) => setAnswers({ ...answers, name: e.target.value })} required maxLength={200} />
          </div>
        )}
        {step === "fields" && (
          <fieldset>
            <legend>Staff always give their name, their email and what needs attention. Also ask:</legend>
            <label className="check">
              <input type="checkbox" checked={answers.extraFields.includes("location")} onChange={(e) => extra("location", e.target.checked)} />
              Where is it?
            </label>
            <label className="check">
              <input type="checkbox" checked={answers.extraFields.includes("details")} onChange={(e) => extra("details", e.target.checked)} />
              Anything else we should know?
            </label>
          </fieldset>
        )}
        {step === "destinations" && (
          <>
            <p>Requests are saved to the request list of {answers.name} in Daloy.</p>
            <div className="field">
              <label htmlFor="setup-notify">Send the office notification to</label>
              <input id="setup-notify" type="email" value={answers.notifyEmail} onChange={(e) => setAnswers({ ...answers, notifyEmail: e.target.value })} required maxLength={254} />
            </div>
            <fieldset>
              <legend>Also send each request to (optional)</legend>
              <label className="check">
                <input type="checkbox" checked={answers.sheets ?? false} onChange={(e) => setAnswers({ ...answers, sheets: e.target.checked })} /> A row in your Google Sheet
              </label>
              <label className="check">
                <input type="checkbox" checked={answers.slack ?? false} onChange={(e) => setAnswers({ ...answers, slack: e.target.checked })} /> A short note in your Slack channel (reference and subject only)
              </label>
              <p className="muted">
                Connect them and pick the sheet and channel in <a href="#/settings/business">Business and email</a>. Turning on checks that they are connected.
              </p>
            </fieldset>
          </>
        )}
        {step === "review" && (
          <>
            <p>When someone submits this form:</p>
            <ul>
              <li>
                Save each request to {answers.name}. {edit("name")}
              </li>
              <li>
                Ask for name, email, what needs attention{answers.extraFields.includes("location") && ", where it is"}
                {answers.extraFields.includes("details") && ", anything else"}. {edit("fields")}
              </li>
              <li>
                Notify the office at {answers.notifyEmail}. {edit("destinations")}
              </li>
              <li>Send the employee a receipt with the request reference.</li>
              {answers.sheets && <li>Add a row to your Google Sheet, starting with the reference. {edit("destinations")}</li>}
              {answers.slack && <li>Post the reference and subject to your Slack channel. {edit("destinations")}</li>}
            </ul>
            <p className="muted">Email goes out through the mail server in this installation's settings. A local demo delivers it to Mailpit.</p>
            <details>
              <summary>Example messages</summary>
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
  const { step, answers, setAnswers, edit, frame } = useWizard<(typeof PURCHASE_SETUP_STEPS)[number], PurchaseRequestAnswers>(
    wf,
    PURCHASE_SETUP_STEPS,
    setup.step,
    setup.answers,
    PURCHASE_REQUEST,
    purchaseRequestDefinition,
    onLive,
  );
  // Only the owner and members with the approver role may decide (decision 0022).
  const [approvers, setApprovers] = useState<Member[] | null>(null);
  useEffect(() => void api<Member[]>("GET", "/workspace/members").then((m) => setApprovers(m.filter((x) => x.role === "owner" || x.role === "approver")), () => setApprovers([])), []);
  const preview = previewPurchaseRequest(answers, SAMPLE_PURCHASE);

  return frame(
    "Purchase request with a named approver",
    PURCHASE_TITLES[step],
    <>
      {step === "name" && (
        <div className="field">
          <label htmlFor="setup-name">Automation name</label>
          <input id="setup-name" value={answers.name} onChange={(e) => setAnswers({ ...answers, name: e.target.value })} required maxLength={200} />
        </div>
      )}
      {step === "approver" && (
        <>
          <div className="field">
            <label htmlFor="setup-approver">Who approves purchases</label>
            <select id="setup-approver" value={answers.approver} onChange={(e) => setAnswers({ ...answers, approver: e.target.value })} required>
              {approvers?.map((m) => (
                <option key={m.userId} value={m.email}>
                  {m.email} ({m.role})
                </option>
              ))}
            </select>
          </div>
          <p className="muted">
            Only this person can approve or reject, signed in to Daloy. A forwarded link does not work for anyone else. To add someone, invite them as an approver on the{" "}
            <a href="#/team">Team</a> page.
          </p>
        </>
      )}
      {step === "destinations" && (
        <>
          <div className="field">
            <label htmlFor="setup-purchasing">Send approved requests to (purchasing)</label>
            <input id="setup-purchasing" type="email" value={answers.purchasingEmail} onChange={(e) => setAnswers({ ...answers, purchasingEmail: e.target.value })} required maxLength={254} />
          </div>
          <fieldset>
            <legend>Microsoft 365 (optional)</legend>
            <label className="check">
              <input type="checkbox" checked={answers.outlook ?? false} onChange={(e) => setAnswers({ ...answers, outlook: e.target.checked })} /> Send the emails from our Outlook mailbox
            </label>
            <label className="check">
              <input type="checkbox" checked={answers.teams ?? false} onChange={(e) => setAnswers({ ...answers, teams: e.target.checked })} /> Post a note in our Teams channel when a purchase is approved
              (reference and item only)
            </label>
            <p className="muted">
              Connect them in <a href="#/settings/business">Business and email</a>. Turning on checks that they are connected. Your organization may need an administrator to
              approve Outlook or the Teams Workflows app; that page says how.
            </p>
          </fieldset>
        </>
      )}
      {step === "review" && (
        <>
          <p>When someone submits this form:</p>
          <ul>
            <li>
              Save the request to {answers.name} with a reference, and send the employee a receipt. {edit("name")}
            </li>
            <li>
              Ask {answers.approver} to approve or reject it, signed in to Daloy. {edit("approver")}
            </li>
            <li>
              If approved, email purchasing at {answers.purchasingEmail}
              {answers.teams && " and post a note in your Teams channel"}, then tell the employee. {edit("destinations")}
            </li>
            <li>If rejected, or nobody decides within a week, tell the employee.</li>
          </ul>
          <p className="muted">
            {answers.outlook ? "Emails to the employee and to purchasing go out from your connected Outlook mailbox." : "Emails go out through the mail server in this installation's settings."} The
            approval request carries a sign-in link and goes out through the Business and email sender. A Teams note never approves anything.
          </p>
          <details>
            <summary>Example messages</summary>
            <p>
              Sample reference: <strong>{preview.reference}</strong>
            </p>
            {preview.messages.map((m) => (
              <Message key={m.title} title={`${m.title} (${m.via})`} mail={m} />
            ))}
            {preview.teamsMessage && (
              <>
                <h3>Note in your Teams channel, once approved</h3>
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
  r.runState === "succeeded" ? done : r.runState === "failed" ? "Stopped, open details" : r.runState === "waiting" ? "Waiting for a decision" : "Sending";

function LivePage({ wf, formId }: { wf: Detail; formId: string }) {
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [copied, setCopied] = useState("");
  const load = () => api<RequestRow[]>("GET", `/workflows/${wf.id}/requests`).then(setRows, () => setRows([]));
  useEffect(() => void load(), [wf.id]);
  const link = `${location.origin}/forms/${formId}`;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const copy = () =>
    navigator.clipboard.writeText(link).then(
      () => setCopied("Form link copied."),
      () => setCopied(`Copy this link: ${link}`),
    );

  return (
    <main className="page">
      <p>{back}</p>
      <h1>{wf.name}</h1>
      <p role="status">
        <span className="tag ok">Accepting requests</span> {copied}
      </p>
      <p>
        Form link: <code>{link}</code>
      </p>
      {local && <p className="muted">This link works on this computer only. To share the form with staff, run Daloy on an address they can reach.</p>}
      <div className="actions">
        <button type="button" className="primary" onClick={() => void copy()}>
          Copy form link
        </button>
        <a href={link} target="_blank" rel="noreferrer">
          Open form
        </a>
        <a href={`#/w/${wf.id}/runs`}>View activity</a>
        <a href={`#/w/${wf.id}`}>Open advanced editor</a>
      </div>
      <h2>Requests</h2>
      <div className="actions">
        <button type="button" className="quiet" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {rows === null ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No requests yet. Open the form and send one.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Subject</th>
                <th scope="col">Received</th>
                <th scope="col">Recorded in</th>
                <th scope="col">Progress</th>
                <th scope="col">Deliveries</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.reference}</td>
                  <td>{r.subject}</td>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>{wf.name}</td>
                  <td>
                    {outcome(r, (wf.setup as { template?: string } | null)?.template === PURCHASE_REQUEST ? "Finished" : "Processed")} <a href={`#/runs/${r.runId}`}>Details</a>
                  </td>
                  <td>{r.deliveries.length ? <DeliveryList deliveries={r.deliveries} onChange={load} /> : <span className="muted">None</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
