import {
  defaultAnswers,
  officeRequestDefinition,
  previewOfficeRequest,
  SAMPLE_REQUEST,
  SETUP_STEPS,
  type OfficeRequestAnswers,
  type Setup,
} from "@daloy/engine";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Workflow } from "./api";

type Step = (typeof SETUP_STEPS)[number];
type Detail = Omit<Workflow, "live"> & { trigger: { id: string } | null; live: unknown };
type RequestRow = { id: string; reference: string; subject: string; createdAt: string; runId: string; runState: string; runError: string | null };

/** "Set up for my office": a new workflow with guided setup progress, named "Office requests" (or -2, -3 when taken). */
export async function startOfficeSetup(email: string) {
  const answers = defaultAnswers(email);
  for (let n = 1; n <= 20; n++) {
    try {
      const wf = await api<Workflow>("POST", "/workflows", { name: answers.name, slug: n === 1 ? "office-requests" : `office-requests-${n}` });
      await api("PATCH", `/workflows/${wf.id}/setup`, { step: "name", answers });
      location.hash = `#/a/${wf.id}`;
      return;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) throw err;
    }
  }
  throw new Error("Rename one of your office request automations and try again.");
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
  const setup = wf.setup as Setup | null;
  if (!setup) return <main className="page">{back}<p>This workflow has no guided setup. <a href={`#/w/${id}`}>Open advanced editor</a></p></main>;
  return wf.live && wf.trigger ? <LivePage wf={wf} formId={wf.trigger.id} /> : <SetupWizard wf={wf} setup={setup} onLive={load} />;
}

const STEP_TITLES: Record<Step, string> = { name: "Name", fields: "Fields staff fill in", destinations: "Where requests and alerts go", review: "Review" };

function SetupWizard({ wf, setup, onLive }: { wf: Detail; setup: Setup; onLive: () => Promise<void> }) {
  const [step, setStep] = useState<Step>(setup.step);
  const [answers, setAnswers] = useState(setup.answers);
  const [error, setError] = useState("");
  const index = SETUP_STEPS.indexOf(step);

  const save = async (next: Step) => {
    setError("");
    try {
      await api("PATCH", `/workflows/${wf.id}/setup`, { step: next, answers });
      if (answers.name !== wf.name) await api("PATCH", `/workflows/${wf.id}`, { name: answers.name });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };
  const next = async (e: FormEvent) => {
    e.preventDefault();
    const to = SETUP_STEPS[index + 1]!;
    if (await save(to)) setStep(to);
  };
  const later = async () => {
    if (await save(step)) location.hash = "#/";
  };
  const turnOn = async () => {
    if (!(await save("review"))) return;
    try {
      await api("POST", `/workflows/${wf.id}/versions`, { definition: officeRequestDefinition(answers), publish: true });
      await onLive();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const extra = (f: "location" | "details", on: boolean) =>
    setAnswers({ ...answers, extraFields: (["location", "details"] as const).filter((x) => (x === f ? on : answers.extraFields.includes(x))) });
  const edit = (to: Step) => (
    <button type="button" className="quiet" onClick={() => setStep(to)}>
      Edit
    </button>
  );

  return (
    <main className="page">
      <p>{back}</p>
      <h1>Set up: Track an office request</h1>
      <p className="muted">
        Step {index + 1} of {SETUP_STEPS.length}: {STEP_TITLES[step]}. Your answers are saved at each step.
      </p>
      <form className="create" onSubmit={step === "review" ? (e) => (e.preventDefault(), void turnOn()) : next}>
        <h2>{STEP_TITLES[step]}</h2>
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
            </ul>
            <p className="muted">Email goes out through the mail server in this installation's settings. A local demo delivers it to Mailpit.</p>
            <details>
              <summary>Example messages</summary>
              <PreviewResult answers={answers} sample={SAMPLE_REQUEST} />
            </details>
          </>
        )}
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
        <div className="actions">
          {index > 0 && (
            <button type="button" className="quiet" onClick={() => setStep(SETUP_STEPS[index - 1]!)}>
              Back
            </button>
          )}
          <button className="primary">{step === "review" ? "Turn on" : "Next"}</button>
          <button type="button" className="quiet" onClick={() => void later()}>
            Save and finish later
          </button>
        </div>
      </form>
    </main>
  );
}

const outcome = (r: RequestRow) =>
  r.runState === "succeeded" ? "Notification and receipt sent" : r.runState === "failed" ? "Not sent, open details" : "Sending";

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
                <th scope="col">Notification</th>
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
                    {outcome(r)} <a href={`#/runs/${r.runId}`}>Details</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
