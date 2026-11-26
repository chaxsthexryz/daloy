import "./workspace-admin.css";
import "./apps-design.css";
import { Text } from "./Language";
import { useLanguage } from "./Language";
import { WEBSITE_INQUIRY_SLUG, websiteInquiryDefinition } from "@daloy/engine";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Workflow } from "./api";
import { ConnectPanel, FieldBadge, useAction } from "./ConnectPanel";
import { CustomerBrandPreview } from "./CustomerBrandPreview";
import { FormEmbed } from "./FormEmbed";

type Profile = { businessName: string | null; website: string | null; inquiryEmail: string | null; replyTo: string | null };
type Sender = { address: string; status: "unverified" | "active" | "failed" | "disconnected"; lastError: string | null; verifiedAt: string | null; lastTestedAt: string | null; authMethod?: "app_password" | "oauth" };
export type Settings = { profile: Profile | null; sender: Sender | null; installationFrom: string | null; installationAllowed: boolean; installationLocal: boolean; signInEmail: string };
type TestResult = { ok: true; to: string; from: string; replyTo?: string; gmail: boolean; needsConfirmation: boolean } | { ok: false; error: string };

const APP_PASSWORD_HELP = "https://support.google.com/accounts/answer/185833";
export const PILL: Record<Sender["status"], string> = { unverified: "Not confirmed", active: "Connected", failed: "Needs attention", disconnected: "Disconnected" };
const STATUS: Record<Sender["status"], string> = {
  unverified: "Waiting for you to confirm the test email",
  active: "Sending from this address",
  failed: "Google rejected the app password",
  disconnected: "Disconnected",
};

/** #/settings/business: the business details and the website inquiry form that uses them (roadmap phase 2). Gmail and the other apps are on Apps. */
export function BusinessSetupPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [data, setData] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const load = () => api<Settings>("GET", "/settings/email").then(setData, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const Wrap = embedded ? "div" : "main";
  return (
    <Wrap className={embedded ? "workspace-admin admin-business motion-page" : "page workspace-admin admin-business motion-page"}>
      {!embedded && (
        <header className="toolbar plain admin-head">
          <h1><Text>Business</Text></h1>
        </header>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {!data ? (
        <p><Text>Loading…</Text></p>
      ) : (
        <>
          <div className="business-grid"><ProfileForm profile={data.profile} onSaved={load} />
          <BrandKit name={data.profile?.businessName} /></div>
          <InquiryForm data={data} />
        </>
      )}
    </Wrap>
  );
}

type Brand = { logoUrl?: string; accent: string | null; logo: boolean };

/** Logo and accent colour (decision 0050). The server checks type, size and colour again; this only saves a round trip. */
function BrandKit({ name }: { name?: string | null }) {
  const { t } = useLanguage();
  const [brand, setBrand] = useState<Brand | null>(null);
  const [colour, setColour] = useState("#1a73e8");
  const [preview, setPreview] = useState("");
  const [fileName, setFileName] = useState("");
  const [logoStatus, setLogoStatus] = useState("");
  const [logoError, setLogoError] = useState("");
  const [colourStatus, setColourStatus] = useState("");
  const [colourError, setColourError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const load = () => api<Brand>("GET", "/settings/brand").then((b) => { setBrand(b); setColour(b.accent ?? "#1a73e8"); }, (e: Error) => setLogoError(e.message));
  useEffect(() => void load(), []);
  const runLogo = async (done: string, fn: () => Promise<unknown>) => {
    setLogoError("");
    setLogoStatus("");
    try {
      await fn();
      await load();
      setLogoStatus(done);
    } catch (err) {
      setLogoError((err as Error).message);
    }
  };
  const runColour = async (done: string, fn: () => Promise<unknown>) => {
    setColourError("");
    setColourStatus("");
    try {
      await fn();
      await load();
      setColourStatus(done);
    } catch (err) {
      setColourError((err as Error).message);
    }
  };
  const upload = () =>
    runLogo("Logo saved.", async () => {
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
      <p className="muted"><Text>Shown on your public forms and in the emails kymavo sends for you. Leave both empty to keep the default look.</Text></p>
      <div className="field">
        <label htmlFor="b-logo"><Text>Logo (PNG, JPEG or WebP, up to 100 KB)</Text></label>
        <div className="file-picker">
          <input
            id="b-logo"
            ref={file}
            className="file-input-native"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
          />
          <span className="file-picker-btn" aria-hidden="true">{t("Choose file")}</span>
          <span className="file-picker-name" aria-hidden="true">{fileName || t("No file selected")}</span>
        </div>
        {preview && <img src={preview} alt="" style={{ maxHeight: 64, maxWidth: 240 }} />}
        <span className="muted">{brand?.logo ? <Text>A logo is saved.</Text> : <Text>No logo yet.</Text>}</span>
      </div>
      <div className="actions">
        <button type="button" onClick={() => void upload()}><Text>Upload logo</Text></button>
        {brand?.logo && <button type="button" onClick={() => void runLogo("Logo removed.", async () => { await api("DELETE", "/settings/brand/logo"); setPreview(""); setFileName(""); })}><Text>Remove logo</Text></button>}
      </div>
      <p role="status" className="inline-feedback" hidden={!logoStatus}>{t(logoStatus)}</p>
      <p role="alert" className="message error" hidden={!logoError}>{logoError}</p>
      <div className="field">
        <label htmlFor="b-accent"><Text>Accent colour</Text></label>
        <input id="b-accent" type="color" value={colour} onChange={(e) => setColour(e.target.value.toLowerCase())} aria-describedby="b-accent-note" />
        <span id="b-accent-note" className="muted"><Text>Text on this colour is chosen to stay readable.</Text></span>
      </div>
      <div className="actions">
        <button type="button" onClick={() => void runColour("Colour saved.", () => api("PUT", "/settings/brand", { accent: colour }))}><Text>Save colour</Text></button>
        {brand?.accent && <button type="button" onClick={() => void runColour("Colour cleared.", () => api("PUT", "/settings/brand", { accent: null }))}><Text>Clear colour</Text></button>}
      </div>
      <p role="status" className="inline-feedback" hidden={!colourStatus}>{t(colourStatus)}</p>
      <p role="alert" className="message error" hidden={!colourError}>{colourError}</p>
      <CustomerBrandPreview businessName={name ?? ""} logoUrl={brand?.logo ? (preview || brand.logoUrl) : null} accent={colour} />
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
  ) : data.installationFrom ? (
    <p>
      Your automations send from <code>{data.installationFrom}</code>, this installation's mail server. On a local install that is Mailpit, which keeps every message on this
      computer (open <a href="http://localhost:8025">localhost:8025</a> to read them).
    </p>
  ) : (
    <p><Text>This installation uses a shared mail server by default. Connect Gmail to send customer email from your own business address.</Text></p>
  );
}

function SenderLine({ sender }: { sender: Sender }) {
  const { t } = useLanguage();
  const status = sender.status === "failed" && sender.authMethod === "oauth" ? "Google no longer accepts kymavo's access" : STATUS[sender.status];
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
  const { t, language } = useLanguage();
  const [test, setTest] = useState<TestResult | null>(null);
  const { error, busy, act } = useAction(onChange);
  if (!google) return <SenderSection data={data} onChange={onChange} />;
  const { sender } = data;
  const live = sender && sender.status !== "disconnected" ? sender : null;
  return (
    <ConnectPanel
      slug="gmail" sectionLabel="Email sender"
      name="Gmail"
      configured
      connectLabel="Connect Gmail with Google"
      label="Gmail:"
      conn={live && { account: live.address, status: live.status, lastError: live.lastError }}
      status={live && <>
        <p className="in-use">Gmail: <strong>{live.address}</strong> <span className="tag">{t(PILL[live.status])}</span></p>
        {live.status !== "failed" && <p>{t(live.authMethod === "oauth" ? "Connected with Google. kymavo can send email as you. kymavo cannot read your mail." : "Connected with an app password.")}</p>}
      </>}
      outcome={outcome}
      intro={!live && <p><Text>Google will ask you to let kymavo send email as you. kymavo cannot read your mail. Automations that receive email still connect their inbox with an app password.</Text></p>}

      disconnect={() => api("POST", "/settings/email/disconnect")}
      removeHint="kymavo deleted its access to Gmail. If Google did not confirm it, or you made an app password for kymavo, remove kymavo in your Google account's security settings too."
      form={<GmailForm address={sender?.address ?? ""} title={t("Use an app password instead")} onSaved={async () => { setTest(null); await onChange(); }} />}
      onChange={onChange}
    >
      {!sender && <InstallationNote data={data} />}
      {live && <>
        <p>{t(live.status === "failed" && live.authMethod === "oauth" ? "Google no longer accepts kymavo's access" : STATUS[live.status])}</p>
        {live.verifiedAt && <p>{t("Confirmed on {date}", { date: new Date(live.verifiedAt).toLocaleDateString(language === "tl" ? "fil-PH" : "en-PH") })}</p>}
        {data.profile?.replyTo && <p>{t("Replies go to {address}", { address: data.profile.replyTo })}</p>}
        {live.lastError && <p className="message error">{live.lastError}</p>}
      </>}
      <Paused sender={sender} />
      <h4>{t("Test email")}</h4>
      {test && <TestOutcome test={test} />}
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
      <p><Text>kymavo sends as you with a Google app password, a 16-letter code that works for email only. Some work and school accounts do not offer them; ask your administrator.</Text></p>
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
        <div className="field-label-row">
          <label htmlFor="g-address"><Text>Gmail address</Text></label>
          <FieldBadge />
        </div>
        <input id="g-address" type="email" value={address} onChange={(e) => setAddress(e.target.value)} required autoComplete="email" />
      </div>
      <div className="field">
        <div className="field-label-row">
          <label htmlFor="g-password"><Text>App password</Text></label>
          <FieldBadge />
        </div>
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
      <a href="#/apps"><Text>Manage sender in Apps</Text></a>
      <p><Text>A visitor fills in your inquiry form. They get a thank-you reply, and the inquiry goes to your inbox. No AI is involved.</Text></p>
      {!ready ? (
        <p className="muted"><Text>Save a business name and an inbox for new inquiries above first.</Text></p>
      ) : (
        <>
          <ul>
            {from ? (
              <li>
                {t("Replies to customers are sent from")} <code>{from}</code>
                {profile.replyTo ? <>{t(", and their answers go to")} <code>{profile.replyTo}</code></> : null}.
              </li>
            ) : (
              <li>
                {t("Connect Gmail in Apps so customer replies come from your own address.")}{profile.replyTo ? <> {t("Replies from customers go to")} <code>{profile.replyTo}</code>.</> : ""}
              </li>
            )}
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
      {local && <p className="muted"><Text>This link works on this computer only. Customers need kymavo running on an address they can reach.</Text></p>}
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
  const { t } = useLanguage();
  type LinkState = "loading" | "ready" | "expired" | "used" | "invalid" | "working" | "done" | "error";
  const [state, setState] = useState<LinkState>("loading");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<{ state: "ready" | "expired" | "used" | "invalid"; address?: string }>("POST", "/settings/email/verify/status", { token }).then(
      (result) => { if (active) { setState(result.state); setAddress(result.address ?? ""); } },
      (err: Error) => { if (active) { setState("error"); setError(err.message); } },
    );
    return () => { active = false; };
  }, [token]);
  async function confirm() {
    setState("working");
    setError("");
    try {
      await api("POST", "/settings/email/verify", { token });
      setState("done");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setState("used");
      else if (err instanceof ApiError && err.status === 410) setState("expired");
      else if (err instanceof ApiError && err.status === 400) setState("invalid");
      else { setState("ready"); setError((err as Error).message); }
    }
  }
  const message: Record<LinkState, string> = {
    loading: "Loading…", ready: "Confirm this address to send customer emails from it. This link works once and lasts 30 minutes.",
    working: "Confirming…", done: "Confirmed. Your automations now send from your Gmail address.",
    expired: "This link has expired. Open Gmail in Apps and send a new test email.",
    used: "This link was already used. Check your sender status in Apps.",
    invalid: "This link is unavailable. Send a new test email.", error: "",
  };
  return (
    <main className="page workspace-admin verify-sender">
      <article className="verify-card motion-page">
        <span className="app-tile" aria-hidden="true">G</span>
        <h1><Text>Confirm your Gmail sender</Text></h1>
        <p role="status">{t(message[state])}</p>
        {address && <p><strong>{address}</strong></p>}
        {error && <p role="alert" className="message error">{t(error)}</p>}
        <div className="actions">
          {(state === "ready" || state === "working") && <button type="button" className="primary" disabled={state === "working"} onClick={() => void confirm()}>{t("Confirm sender")}</button>}
          <a href="#/apps"><Text>Back to Apps</Text></a>
        </div>
      </article>
    </main>
  );
}
