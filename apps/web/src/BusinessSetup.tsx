import { WEBSITE_INQUIRY_SLUG, websiteInquiryDefinition } from "@daloy/engine";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Workflow } from "./api";

type Profile = { businessName: string | null; website: string | null; inquiryEmail: string | null; replyTo: string | null };
type Sender = { address: string; status: "unverified" | "active" | "failed" | "disconnected"; lastError: string | null; verifiedAt: string | null; lastTestedAt: string | null };
type Settings = { profile: Profile | null; sender: Sender | null; installationFrom: string; signInEmail: string };
type TestResult = { ok: true; to: string; from: string; replyTo?: string; gmail: boolean; needsConfirmation: boolean } | { ok: false; error: string };

const APP_PASSWORD_HELP = "https://support.google.com/accounts/answer/185833";
const STATUS: Record<Sender["status"], string> = {
  unverified: "Waiting for you to confirm the test email",
  active: "Sending from this address",
  failed: "Google rejected the app password",
  disconnected: "Disconnected",
};

const back = <a href="#/">Home</a>;

/** Business profile, the owner's own Gmail sender and the website inquiry form (roadmap phase 2). */
export function BusinessSetupPage() {
  const [data, setData] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const load = () => api<Settings>("GET", "/settings/email").then(setData, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  return (
    <main className="page narrow">
      <header className="toolbar plain">
        {back}
        <h1>Business and email</h1>
      </header>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {!data ? (
        <p>Loading…</p>
      ) : (
        <>
          <ProfileForm profile={data.profile} onSaved={load} />
          <SenderSection data={data} onChange={load} />
          <InquiryForm data={data} />
        </>
      )}
    </main>
  );
}

function ProfileForm({ profile, onSaved }: { profile: Profile | null; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({
    businessName: profile?.businessName ?? "",
    website: profile?.website ?? "",
    inquiryEmail: profile?.inquiryEmail ?? "",
    replyTo: profile?.replyTo ?? "",
  });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const field = (name: keyof typeof form) => ({ id: `p-${name}`, value: form[name], onChange: (e: { target: { value: string } }) => setForm({ ...form, [name]: e.target.value }) });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setStatus("");
    try {
      await api("PUT", "/settings/email/profile", form);
      await onSaved();
      setStatus("Saved.");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form onSubmit={save} aria-labelledby="profile-h">
      <h2 id="profile-h">Your business</h2>
      <div className="field">
        <label htmlFor="p-businessName">Business name</label>
        <input {...field("businessName")} required maxLength={120} />
      </div>
      <div className="field">
        <label htmlFor="p-website">Website</label>
        <input {...field("website")} type="url" placeholder="https://" aria-describedby="p-website-note" />
        <span id="p-website-note" className="muted">
          For your records only. Saving it does not connect a form that is already on your website.
        </span>
      </div>
      <div className="field">
        <label htmlFor="p-inquiryEmail">Inbox for new inquiries</label>
        <input {...field("inquiryEmail")} type="email" />
      </div>
      <div className="field">
        <label htmlFor="p-replyTo">Reply address (optional)</label>
        <input {...field("replyTo")} type="email" aria-describedby="p-replyTo-note" />
        <span id="p-replyTo-note" className="muted">
          When a customer answers one of your emails, the answer goes here.
        </span>
      </div>
      <div className="actions">
        <button type="submit" className="primary">
          Save business details
        </button>
      </div>
      <p role="status">{status}</p>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </form>
  );
}

function SenderSection({ data, onChange }: { data: Settings; onChange: () => Promise<void> }) {
  const { sender } = data;
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
      await onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sendTest = () => act(async () => setTest(await api<TestResult>("POST", "/settings/email/test")));
  const showForm = !sender || editing || sender.status === "disconnected";

  return (
    <section aria-labelledby="sender-h">
      <h2 id="sender-h">Email sender</h2>
      {!sender ? (
        <p>
          Your automations send from <code>{data.installationFrom}</code>, this installation's mail server. On a local install that is Mailpit, which keeps every message on this
          computer (open <a href="http://localhost:8025">localhost:8025</a> to read them).
        </p>
      ) : (
        <p className="in-use">
          Gmail: <strong>{sender.address}</strong>
          <span className={`tag${sender.status === "active" ? " ok" : ""}`}>{STATUS[sender.status]}</span>
          {sender.lastError && <span className="message error"> {sender.lastError}</span>}
        </p>
      )}
      {sender?.status === "failed" && <p>Mail from your automations is paused. Replace the app password to send again. Nothing is sent from another address in the meantime.</p>}
      {sender?.status === "disconnected" && <p>Mail from your automations is paused until you reconnect Gmail. Nothing is sent from another address in the meantime.</p>}

      <div className="actions">
        <button type="button" disabled={busy || sender?.status === "disconnected"} onClick={() => void sendTest()}>
          Send a test email to me
        </button>
        {sender && sender.status !== "disconnected" && !editing && (
          <button type="button" className="quiet" onClick={() => setEditing(true)}>
            Replace password
          </button>
        )}
        {sender && sender.status !== "disconnected" && (
          <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => api("POST", "/settings/email/disconnect"))}>
            Disconnect
          </button>
        )}
        {sender?.status === "disconnected" && (
          <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => api("DELETE", "/settings/email/gmail"))}>
            Use the local mail server instead
          </button>
        )}
      </div>
      {test && <TestOutcome test={test} />}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {showForm && (
        <GmailForm
          address={sender?.address ?? ""}
          title={!sender ? "Connect Gmail" : sender.status === "disconnected" ? "Reconnect Gmail" : "Replace password"}
          onSaved={async () => {
            setEditing(false);
            setTest(null);
            await onChange();
          }}
          onCancel={sender && sender.status !== "disconnected" ? () => setEditing(false) : undefined}
        />
      )}
    </section>
  );
}

function TestOutcome({ test }: { test: TestResult }) {
  if (!test.ok)
    return (
      <p role="alert" className="message error">
        The test email was not sent: {test.error}
      </p>
    );
  return (
    <div role="status">
      <p>
        {test.gmail ? "Google" : "The mail server"} accepted a test email to <strong>{test.to}</strong>, sent from <code>{test.from}</code>
        {test.replyTo && (
          <>
            {" "}
            with replies going to <code>{test.replyTo}</code>
          </>
        )}
        . Check that it arrived in your inbox: accepted does not yet mean delivered.
      </p>
      {test.needsConfirmation && <p>Open the link in that email while you are signed in here. Your automations start sending from this address after that.</p>}
    </div>
  );
}

function GmailForm({ address: initial, title, onSaved, onCancel }: { address: string; title: string; onSaved: () => Promise<void>; onCancel?: () => void }) {
  const [address, setAddress] = useState(initial);
  const [appPassword, setAppPassword] = useState("");
  const [error, setError] = useState("");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api("PUT", "/settings/email/gmail", { address, appPassword });
      setAppPassword("");
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form onSubmit={save} aria-labelledby="gmail-h">
      <h3 id="gmail-h">{title}</h3>
      <p>
        Daloy sends as you with a Google app password, a 16-letter code that works for email only. Your Google account needs 2-Step Verification turned on before Google offers
        app passwords. Some work and school accounts do not offer them; ask your administrator.{" "}
        <a href={APP_PASSWORD_HELP} target="_blank" rel="noreferrer">
          How to create an app password
        </a>
      </p>
      <div className="field">
        <label htmlFor="g-address">Gmail address</label>
        <input id="g-address" type="email" value={address} onChange={(e) => setAddress(e.target.value)} required autoComplete="email" />
      </div>
      <div className="field">
        <label htmlFor="g-password">App password</label>
        <input id="g-password" type="password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} required autoComplete="off" />
      </div>
      <div className="actions">
        <button type="submit" className="primary">
          Save Gmail sender
        </button>
        {onCancel && (
          <button type="button" className="quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </form>
  );
}

/** Builds the "Website inquiries" automation from the saved profile and publishes it, then offers its form link. */
function InquiryForm({ data }: { data: Settings }) {
  const [formId, setFormId] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const { profile, sender } = data;

  const find = async () => {
    const wf = (await api<Workflow[]>("GET", "/workflows")).find((w) => w.slug === WEBSITE_INQUIRY_SLUG);
    if (!wf) return null;
    const detail = await api<{ trigger: { id: string } | null; live: unknown }>("GET", `/workflows/${wf.id}`);
    setWorkflowId(wf.id);
    setFormId(detail.live && detail.trigger ? detail.trigger.id : null);
    return wf.id;
  };
  useEffect(() => void find().catch(() => {}), []);

  const ready = !!profile?.businessName && !!profile.inquiryEmail;
  const from = sender ? sender.address : data.installationFrom;
  const turnOn = async () => {
    setError("");
    setStatus("");
    try {
      let id = workflowId ?? (await find());
      if (!id) {
        try {
          id = (await api<Workflow>("POST", "/workflows", { name: "Website inquiries", slug: WEBSITE_INQUIRY_SLUG })).id;
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 409)) throw err;
          id = await find();
        }
      }
      const definition = websiteInquiryDefinition({ businessName: profile!.businessName!, inquiryEmail: profile!.inquiryEmail! });
      await api("POST", `/workflows/${id}/versions`, { definition, publish: true });
      await find();
      setStatus("Inquiry replies are on.");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const link = formId ? `${location.origin}/forms/${formId}` : "";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

  return (
    <section aria-labelledby="inquiry-h">
      <h2 id="inquiry-h">Reply to website inquiries</h2>
      <p>A visitor fills in your inquiry form. They get a thank-you reply, and the inquiry goes to your inbox. No AI is involved.</p>
      {!ready ? (
        <p className="muted">Save a business name and an inbox for new inquiries above first.</p>
      ) : (
        <>
          <ul>
            <li>
              Replies to customers are sent from <code>{from}</code>
              {profile.replyTo && (
                <>
                  , and their answers go to <code>{profile.replyTo}</code>
                </>
              )}
              .
            </li>
            <li>
              New inquiries go to <code>{profile.inquiryEmail}</code>.
            </li>
          </ul>
          {sender && sender.status !== "active" && <p className="message error">Customer replies will not be sent until Gmail is confirmed and working.</p>}
          <div className="actions">
            <button type="button" className="primary" onClick={() => void turnOn()}>
              {formId ? "Update inquiry replies" : "Turn on inquiry replies"}
            </button>
          </div>
        </>
      )}
      <p role="status">{status}</p>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {formId && <FormLink link={link} local={local} workflowId={workflowId!} />}
    </section>
  );
}

function FormLink({ link, local, workflowId }: { link: string; local: boolean; workflowId: string }) {
  const [copied, setCopied] = useState("");
  const copy = () =>
    navigator.clipboard.writeText(link).then(
      () => setCopied("Inquiry form link copied."),
      () => setCopied(`Copy this link: ${link}`),
    );
  return (
    <>
      <p>
        Inquiry form link: <code>{link}</code>
      </p>
      {local && <p className="muted">This link works on this computer only. Customers need Daloy running on an address they can reach.</p>}
      <div className="actions">
        <button type="button" onClick={() => void copy()}>
          Copy inquiry form link
        </button>
        <a href={link} target="_blank" rel="noreferrer">
          Open form
        </a>
        <a href={`#/w/${workflowId}/runs`}>View activity</a>
      </div>
      <p role="status">{copied}</p>
      <h3>Put it behind your website's contact button</h3>
      <p>
        In your website builder, edit the Contact button and set its link to the inquiry form link above. If your website already has its own form, that form keeps working as
        before and does not reach Daloy. Sending its entries here needs a developer, or an integration Daloy does not have yet.
      </p>
    </>
  );
}

/** Opened from the link in the test email. The API checks that the signed-in owner is the one it was sent to. */
export function VerifySenderPage({ token }: { token: string }) {
  const [state, setState] = useState<"working" | "done" | string>("working");
  // The link works once, and React runs effects twice in development, so claim it only once per page load.
  const claimed = useRef(false);
  useEffect(() => {
    if (claimed.current) return;
    claimed.current = true;
    api("POST", "/settings/email/verify", { token }).then(
      () => setState("done"),
      (e: Error) => setState(e.message),
    );
  }, [token]);
  return (
    <main className="page narrow">
      <h1>Confirm your Gmail sender</h1>
      {state === "working" ? (
        <p>Confirming…</p>
      ) : state === "done" ? (
        <p role="status">Confirmed. Your automations now send from your Gmail address.</p>
      ) : (
        <p role="alert" className="message error">
          {state}
        </p>
      )}
      <p>
        <a href="#/settings/business">Back to Business and email</a>
      </p>
    </main>
  );
}
