import { Text } from "./Language";
import { useLanguage } from "./Language";
import { WEBSITE_INQUIRY_SLUG, websiteInquiryDefinition } from "@daloy/engine";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Workflow } from "./api";
import { ConnectPanel, useAction } from "./ConnectPanel";
import { FormEmbed } from "./FormEmbed";

type Profile = { businessName: string | null; website: string | null; inquiryEmail: string | null; replyTo: string | null };
type Sender = { address: string; status: "unverified" | "active" | "failed" | "disconnected"; lastError: string | null; verifiedAt: string | null; lastTestedAt: string | null; authMethod?: "app_password" | "oauth" };
export type Settings = { profile: Profile | null; sender: Sender | null; installationFrom: string; installationAllowed: boolean; installationLocal: boolean; signInEmail: string };
type TestResult = { ok: true; to: string; from: string; replyTo?: string; gmail: boolean; needsConfirmation: boolean } | { ok: false; error: string };

const APP_PASSWORD_HELP = "https://support.google.com/accounts/answer/185833";
export const PILL: Record<Sender["status"], string> = { unverified: "Not confirmed", active: "Connected", failed: "Needs attention", disconnected: "Disconnected" };
const STATUS: Record<Sender["status"], string> = {
  unverified: "Waiting for you to confirm the test email",
  active: "Sending from this address",
  failed: "Google rejected the app password",
  disconnected: "Disconnected",
};

const back = <a href="#/settings"><Text>Settings</Text></a>;

/** #/settings/business: the business details and the website inquiry form that uses them (roadmap phase 2). Gmail and the other apps are on Apps. */
export function BusinessSetupPage() {
  const [data, setData] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const load = () => api<Settings>("GET", "/settings/email").then(setData, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  return (
    <main className="page narrow">
      <header className="toolbar plain">
        {back}
        <h1><Text>Business</Text></h1>
      </header>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {!data ? (
        <p><Text>Loading…</Text></p>
      ) : (
        <>
          <ProfileForm profile={data.profile} onSaved={load} />
          <BrandKit />
          <InquiryForm data={data} />
        </>
      )}
    </main>
  );
}

type Brand = { accent: string | null; logo: boolean };

/** Logo and accent colour (decision 0050). The server checks type, size and colour again; this only saves a round trip. */
function BrandKit() {
  const { t } = useLanguage();
  const [brand, setBrand] = useState<Brand | null>(null);
  const [colour, setColour] = useState("#1a73e8");
  const [preview, setPreview] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const load = () => api<Brand>("GET", "/settings/brand").then((b) => { setBrand(b); if (b.accent) setColour(b.accent); }, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const run = async (done: string, fn: () => Promise<unknown>) => {
    setError("");
    setStatus("");
    try {
      await fn();
      await load();
      setStatus(done);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const upload = () =>
    run("Logo saved.", async () => {
      const chosen = file.current?.files?.[0];
      if (!chosen) throw new Error(t("Choose a file first."));
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("The file could not be read"));
        reader.readAsDataURL(chosen);
      });
      await api("PUT", "/settings/brand/logo", { data: url.slice(url.indexOf(",") + 1) });
      setPreview(url);
    });
  return (
    <section aria-labelledby="brand-h">
      <h2 id="brand-h"><Text>Logo and colour</Text></h2>
      <p className="muted"><Text>Shown on your public forms and in the emails Daloy sends for you. Leave both empty to keep the default look.</Text></p>
      <div className="field">
        <label htmlFor="b-logo"><Text>Logo (PNG, JPEG or WebP, up to 100 KB)</Text></label>
        <input id="b-logo" ref={file} type="file" accept="image/png,image/jpeg,image/webp" />
        {preview && <img src={preview} alt="" style={{ maxHeight: 64, maxWidth: 240 }} />}
        <span className="muted">{brand?.logo ? <Text>A logo is saved.</Text> : <Text>No logo yet.</Text>}</span>
      </div>
      <div className="actions">
        <button type="button" onClick={() => void upload()}><Text>Upload logo</Text></button>
        {brand?.logo && <button type="button" onClick={() => void run("Logo removed.", async () => { await api("DELETE", "/settings/brand/logo"); setPreview(""); })}><Text>Remove logo</Text></button>}
      </div>
      <div className="field">
        <label htmlFor="b-accent"><Text>Accent colour</Text></label>
        <input id="b-accent" type="color" value={colour} onChange={(e) => setColour(e.target.value.toLowerCase())} aria-describedby="b-accent-note" />
        <span id="b-accent-note" className="muted"><Text>Text on this colour is chosen to stay readable.</Text></span>
      </div>
      <div className="actions">
        <button type="button" onClick={() => void run("Colour saved.", () => api("PUT", "/settings/brand", { accent: colour }))}><Text>Save colour</Text></button>
        {brand?.accent && <button type="button" onClick={() => void run("Colour cleared.", () => api("PUT", "/settings/brand", { accent: null }))}><Text>Clear colour</Text></button>}
      </div>
      <p role="status">{t(status)}</p>
      <p role="alert" className="message error" hidden={!error}>{error}</p>
    </section>
  );
}

function ProfileForm({ profile, onSaved }: { profile: Profile | null; onSaved: () => Promise<void> }) {
  const { t } = useLanguage();
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
      <h2 id="profile-h"><Text>Your business</Text></h2>
      <div className="field">
        <label htmlFor="p-businessName"><Text>Business name</Text></label>
        <input {...field("businessName")} required maxLength={120} />
      </div>
      <div className="field">
        <label htmlFor="p-website"><Text>Website</Text></label>
        <input {...field("website")} type="url" placeholder="https://" aria-describedby="p-website-note" />
        <span id="p-website-note" className="muted">
          <Text>For your records only. Saving it does not connect a form that is already on your website.</Text>
        </span>
      </div>
      <div className="field">
        <label htmlFor="p-inquiryEmail"><Text>Inbox for new inquiries</Text></label>
        <input {...field("inquiryEmail")} type="email" />
      </div>
      <div className="field">
        <label htmlFor="p-replyTo"><Text>Reply address (optional)</Text></label>
        <input {...field("replyTo")} type="email" aria-describedby="p-replyTo-note" />
        <span id="p-replyTo-note" className="muted">
          <Text>When a customer answers one of your emails, the answer goes here.</Text>
        </span>
      </div>
      <div className="actions">
        <button type="submit" className="primary">
          <Text>Save business details</Text>
        </button>
      </div>
      <p role="status">{t(status)}</p>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </form>
  );
}

export function SenderSection({ data, onChange }: { data: Settings; onChange: () => Promise<void> }) {
  const { t } = useLanguage();
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
      <h2 id="sender-h">
        {t("Email sender")} <span className={`tag${sender?.status === "active" ? " ok" : ""}`}>{t(sender ? PILL[sender.status] : "Not connected")}</span>
      </h2>
      {!sender ? <InstallationNote data={data} /> : <SenderLine sender={sender} />}
      <Paused sender={sender} />

      <div className="actions">
        <button type="button" disabled={busy || sender?.status === "disconnected"} onClick={() => void sendTest()}>
          <Text>Send a test email to me</Text>
        </button>
        {sender && sender.status !== "disconnected" && !editing && (
          <button type="button" className="quiet" onClick={() => setEditing(true)}>
            <Text>Replace password</Text>
          </button>
        )}
        {sender && sender.status !== "disconnected" && (
          <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm(t("Disconnect Gmail? Email from your automations pauses until you reconnect.")) && void act(() => api("POST", "/settings/email/disconnect"))}>
            <Text>Disconnect</Text>
          </button>
        )}
        {sender?.status === "disconnected" && (
          <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => api("DELETE", "/settings/email/gmail"))}>
            <Text>Use the local mail server instead</Text>
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
          title={t(!sender ? "Connect Gmail" : sender.status === "disconnected" ? "Reconnect Gmail" : "Replace password")}
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

function InstallationNote({ data }: { data: Settings }) {
  return !data.installationAllowed ? (
    <p className="message error"><Text>This installation's mail server does not send for your account. Connect Gmail below to send email from your own address.</Text></p>
  ) : (
    <p>
      Your automations send from <code>{data.installationFrom}</code>, this installation's mail server. On a local install that is Mailpit, which keeps every message on this
      computer (open <a href="http://localhost:8025">localhost:8025</a> to read them).
    </p>
  );
}

function SenderLine({ sender }: { sender: Sender }) {
  const { t } = useLanguage();
  const status = sender.status === "failed" && sender.authMethod === "oauth" ? "Google no longer accepts Daloy's access" : STATUS[sender.status];
  return (
    <p className="in-use">
      Gmail: <strong>{sender.address}</strong>
      <span className={`tag${sender.status === "active" ? " ok" : ""}`}>{t(status)}</span>
      {sender.lastError && <span className="message error"> {sender.lastError}</span>}
    </p>
  );
}

/** Decision 0020: a failed or disconnected sender pauses mail, and nothing is sent from another address. */
function Paused({ sender }: { sender: Sender | null }) {
  if (sender?.status === "failed" && sender.authMethod === "oauth") return <p><Text>Mail from your automations is paused. Reconnect Gmail to send again. Nothing is sent from another address in the meantime.</Text></p>;
  if (sender?.status === "failed") return <p><Text>Mail from your automations is paused. Replace the app password to send again. Nothing is sent from another address in the meantime.</Text></p>;
  if (sender?.status === "disconnected") return <p><Text>Mail from your automations is paused until you reconnect Gmail. Nothing is sent from another address in the meantime.</Text></p>;
  return null;
}

/**
 * Gmail on Apps (decision 0063). With a Google client on this installation the main action is Connect Gmail with
 * Google (gmail.send, sent through the Gmail API) and the app password form is under Advanced. Without one, the app
 * password card as before.
 */
export function GmailCard({ data, google, outcome, onChange }: { data: Settings; google: boolean; outcome?: string; onChange: () => Promise<void> }) {
  const { t } = useLanguage();
  const [test, setTest] = useState<TestResult | null>(null);
  const { error, busy, act } = useAction(onChange);
  if (!google) return <SenderSection data={data} onChange={onChange} />;
  const { sender } = data;
  const live = sender && sender.status !== "disconnected" ? sender : null;
  return (
    <ConnectPanel
      slug="gmail"
      name="Gmail"
      configured
      connectLabel="Connect Gmail with Google"
      label="Gmail:"
      conn={live && { account: live.address, status: live.status, lastError: live.lastError }}
      status={live && <SenderLine sender={live} />}
      outcome={outcome}
      intro={!live && <p><Text>Google will ask you to let Daloy send email as you. Daloy cannot read your mail. Automations that receive email still connect their inbox with an app password.</Text></p>}
      after={test && <TestOutcome test={test} />}
      disconnect={() => api("POST", "/settings/email/disconnect")}
      removeHint="Daloy deleted its access to Gmail. If Google did not confirm it, or you made an app password for Daloy, remove Daloy in your Google account's security settings too."
      form={<GmailForm address={sender?.address ?? ""} title={t("Use an app password instead")} onSaved={async () => { setTest(null); await onChange(); }} />}
      onChange={onChange}
    >
      {!sender && <InstallationNote data={data} />}
      <Paused sender={sender} />
      <div className="actions">
        <button type="button" disabled={busy || sender?.status === "disconnected"} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/email/test")))}>
          <Text>Send a test email to me</Text>
        </button>
        {sender?.status === "disconnected" && (
          <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => api("DELETE", "/settings/email/gmail"))}>
            <Text>Use the local mail server instead</Text>
          </button>
        )}
      </div>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </ConnectPanel>
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
      {test.needsConfirmation && <p><Text>Open the link in that email while you are signed in here. Your automations start sending from this address after that.</Text></p>}
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
    <form onSubmit={save} aria-labelledby="gmail-form-h">
      <h3 id="gmail-form-h">{title}</h3>
      <p><Text>Daloy sends as you with a Google app password, a 16-letter code that works for email only. Some work and school accounts do not offer them; ask your administrator.</Text></p>
      <ol className="numbered">
        <li><Text>Turn on 2-Step Verification in your Google account. Google offers app passwords only after that.</Text></li>
        <li>
          Create an app password.{" "}
          <a href={APP_PASSWORD_HELP} target="_blank" rel="noreferrer">
            <Text>How to create an app password</Text>
          </a>
        </li>
        <li><Text>Enter your Gmail address and the app password below, then save.</Text></li>
      </ol>
      <div className="field">
        <label htmlFor="g-address"><Text>Gmail address</Text></label>
        <input id="g-address" type="email" value={address} onChange={(e) => setAddress(e.target.value)} required autoComplete="email" />
      </div>
      <div className="field">
        <label htmlFor="g-password"><Text>App password</Text></label>
        <input id="g-password" type="password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} required autoComplete="off" />
      </div>
      <div className="actions">
        <button type="submit" className="primary">
          <Text>Save Gmail sender</Text>
        </button>
        {onCancel && (
          <button type="button" className="quiet" onClick={onCancel}>
            <Text>Cancel</Text>
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
  const { language, t } = useLanguage();
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
      const definition = websiteInquiryDefinition({ businessName: profile!.businessName!, inquiryEmail: profile!.inquiryEmail! }, language);
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
      <h2 id="inquiry-h"><Text>Reply to website inquiries</Text></h2>
      <p><Text>A visitor fills in your inquiry form. They get a thank-you reply, and the inquiry goes to your inbox. No AI is involved.</Text></p>
      {!ready ? (
        <p className="muted"><Text>Save a business name and an inbox for new inquiries above first.</Text></p>
      ) : (
        <>
          <ul>
            <li>
              {t("Replies to customers are sent from")} <code>{from}</code>
              {profile.replyTo && (
                <>
                  {t(", and their answers go to")} <code>{profile.replyTo}</code>
                </>
              )}
              .
            </li>
            <li>
              {t("New inquiries go to")} <code>{profile.inquiryEmail}</code>.
            </li>
          </ul>
          {sender && sender.status !== "active" && <p className="message error"><Text>Customer replies will not be sent until Gmail is confirmed and working.</Text></p>}
          <div className="actions">
            <button type="button" className="primary" onClick={() => void turnOn()}>
              {t(formId ? "Update inquiry replies" : "Turn on inquiry replies")}
            </button>
          </div>
        </>
      )}
      <p role="status">{t(status)}</p>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {formId && <FormLink link={link} local={local} workflowId={workflowId!} />}
    </section>
  );
}

function FormLink({ link, local, workflowId }: { link: string; local: boolean; workflowId: string }) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState("");
  const copy = () =>
    navigator.clipboard.writeText(link).then(
      () => setCopied(t("Inquiry form link copied.")),
      () => setCopied(t("Copy this link: {link}", { link })),
    );
  return (
    <>
      <p>
        {t("Inquiry form link:")} <code>{link}</code>
      </p>
      {local && <p className="muted"><Text>This link works on this computer only. Customers need Daloy running on an address they can reach.</Text></p>}
      <div className="actions">
        <button type="button" onClick={() => void copy()}>
          {t("Copy inquiry form link")}
        </button>
        <FormEmbed link={link} />
        <a href={link} target="_blank" rel="noreferrer">
          {t("Open form")}
        </a>
        <a href={`#/w/${workflowId}/runs`}><Text>View activity</Text></a>
      </div>
      <p role="status">{copied}</p>
      <h3><Text>Put it behind your website's contact button</Text></h3>
      <p>
        <Text>Set your Contact button to the inquiry form link. To display the form on your page, paste the embed code into an HTML block.</Text>
        To keep your existing form, you can send its notification emails to a folder connected to an email-in automation.
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
      <h1><Text>Confirm your Gmail sender</Text></h1>
      {state === "working" ? (
        <p><Text>Confirming…</Text></p>
      ) : state === "done" ? (
        <p role="status"><Text>Confirmed. Your automations now send from your Gmail address.</Text></p>
      ) : (
        <p role="alert" className="message error">
          {state}
        </p>
      )}
      <p>
        <a href="#/apps"><Text>Back to Apps</Text></a>
      </p>
    </main>
  );
}
