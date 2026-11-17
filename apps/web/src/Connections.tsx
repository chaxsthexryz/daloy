import { useLanguage } from "./Language";
import { useState, type FormEvent } from "react";
import { api } from "./api";

export type Provider = "google_sheets" | "slack" | "outlook" | "teams" | "telegram" | "google_calendar" | "paymongo" | "airtable" | "notion" | "trello";
export type Connection = { provider: Provider; status: "active" | "failed"; account: string; destination: Record<string, string> | null; lastError: string | null; lastTestedAt: string | null };
type TestResult = { ok: true; range?: string; channel?: string } | { ok: false; error: string };
export type OutlookSetup = { configured: boolean; adminConsentUrl?: string };
type Channel = { id: string; name: string; isMember: boolean };

const SERVICE_ACCOUNT_HELP = "https://cloud.google.com/iam/docs/service-accounts-create";
const SLACK_APP_HELP = "https://api.slack.com/quickstart";
const TELEGRAM_BOT_HELP = "https://core.telegram.org/bots/tutorial";
const TEAMS_WORKFLOWS_HELP = "https://support.microsoft.com/en-us/workflows/send-messages-in-teams-using-incoming-webhooks";
const MICROSOFT_CONSENT_HELP = "https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent";

/** What the Outlook consent callback reported, by the code in #/settings/business/outlook-<code>. */
const OUTLOOK_OUTCOMES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Outlook is connected. Send a test email to check it." },
  admin_approved: { ok: true, text: "An administrator approved Daloy for your organization. Connect Outlook now." },
  admin_required: { ok: false, text: "Your organization only lets an administrator approve new apps. Send your administrator the approval link below, then connect again." },
  declined: { ok: false, text: "Microsoft says the permission request was declined, so nothing was connected. Connect again when you are ready." },
  expired: { ok: false, text: "That sign-in took too long or was started by someone else. Start again with Connect Outlook." },
  failed: { ok: false, text: "Microsoft did not finish connecting. Start again with Connect Outlook." },
};

function useAction(onChange: () => Promise<unknown>) {
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
  return { error, busy, act };
}

function Status({ conn, label }: { conn: Connection; label: string }) {
  const { t } = useLanguage();
  return (
    <p className="in-use">
      {t(label)} <strong>{conn.account}</strong>
      <span className={`tag${conn.status === "active" ? " ok" : ""}`}>{conn.status === "active" ? t("Connected") : t("Needs reconnecting")}</span>
      {conn.lastError && <span className="message error"> {conn.lastError}</span>}
    </p>
  );
}

function Outcome({ test, what }: { test: TestResult | null; what: string }) {
  const { t } = useLanguage();
  if (!test) return null;
  return test.ok ? (
    <p role="status">
      {what} {test.range ? `(${test.range})` : ""}{t(". Check that it is there.")}</p>
  ) : (
    <p role="alert" className="message error">{t("The test did not go through: ")}{test.error}
    </p>
  );
}

export function SheetsConnection({ conn, onChange }: { conn: Connection | null; onChange: () => Promise<unknown> }) {
  const { t } = useLanguage();
  const { error, busy, act } = useAction(onChange);
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [form, setForm] = useState({ serviceAccount: "", sheet: "", tab: conn?.destination?.tab ?? "Sheet1" });
  // The key file names the account to share the sheet with. Read here only to show it; the file is sent once, on save.
  let shareWith = conn?.account ?? "";
  try {
    shareWith = (JSON.parse(form.serviceAccount) as { client_email?: string }).client_email ?? shareWith;
  } catch {
    // not pasted yet
  }
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      if (conn && !form.serviceAccount) await api("PUT", "/settings/connections/google-sheets/destination", { sheet: form.sheet, tab: form.tab });
      else await api("PUT", "/settings/connections/google-sheets", form);
      setForm({ ...form, serviceAccount: "" });
      setEditing(false);
      setTest(null);
    });
  };
  const showForm = !conn || editing;

  return (
    <div className="connection" aria-labelledby="sheets-h">
      <h3 id="sheets-h">Google Sheets</h3>
      {conn && <Status conn={conn} label={t("Service account")} />}
      {conn?.destination && (
        <p>{t("Rows go to ")}<strong>{conn.destination.title}</strong>{t(", tab ")}<strong>{conn.destination.tab}</strong>{t(". Column A holds the request reference, column B the time.")}</p>
      )}
      {conn && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/google-sheets/test")))}>{t("Add a test row")}</button>
          {!editing && (
            <button type="button" className="quiet" onClick={() => setEditing(true)}>{t("Change sheet or key")}</button>
          )}
          <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm(t("Disconnect Sheets? Automations stop sending there until you reconnect.")) && void act(() => api("DELETE", "/settings/connections/google-sheets"))}>{t("Disconnect")}</button>
        </div>
      )}
      <Outcome test={test} what={t("Google Sheets accepted a test row")} />
      {showForm && (
        <form onSubmit={save}>
          <p>{t("Daloy writes as a Google Cloud service account, so no personal Google sign-in is stored. Create a service account in a Google Cloud project with the Google Sheets API turned on, add a JSON key, then share your sheet with the account's email as an Editor.")}{" "}
            <a href={SERVICE_ACCOUNT_HELP} target="_blank" rel="noreferrer">{t("How to create a service account")}</a>
          </p>
          <div className="field">
            <label htmlFor="s-key">{t("Service account key file (JSON)")}{conn ? t(", leave empty to keep the current key") : ""}</label>
            <textarea id="s-key" rows={4} value={form.serviceAccount} onChange={(e) => setForm({ ...form, serviceAccount: e.target.value })} required={!conn} autoComplete="off" spellCheck={false} />
          </div>
          {shareWith && (
            <p className="muted">{t("Share the sheet with ")}<code>{shareWith}</code>{t(" as an Editor.")}</p>
          )}
          <div className="field">
            <label htmlFor="s-sheet">{t("Sheet link")}</label>
            <input id="s-sheet" value={form.sheet} onChange={(e) => setForm({ ...form, sheet: e.target.value })} required placeholder="https://docs.google.com/spreadsheets/d/…" />
          </div>
          <div className="field">
            <label htmlFor="s-tab">{t("Tab name")}</label>
            <input id="s-tab" value={form.tab} onChange={(e) => setForm({ ...form, tab: e.target.value })} required maxLength={100} />
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {conn ? t("Save sheet") : t("Connect Google Sheets")}
            </button>
            {conn && (
              <button type="button" className="quiet" onClick={() => setEditing(false)}>{t("Cancel")}</button>
            )}
          </div>
        </form>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </div>
  );
}

export function CalendarConnection({ conn, onChange }: { conn: Connection | null; onChange: () => Promise<unknown> }) {
  const { error, busy, act } = useAction(onChange);
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [form, setForm] = useState({ serviceAccount: "", calendar: "" });
  // The key file names the account to share the calendar with. Read here only to show it; the file is sent once, on save.
  let shareWith = conn?.account ?? "";
  try {
    shareWith = (JSON.parse(form.serviceAccount) as { client_email?: string }).client_email ?? shareWith;
  } catch {
    // not pasted yet
  }
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api("PUT", "/settings/connections/google-calendar", form);
      setForm({ serviceAccount: "", calendar: "" });
      setEditing(false);
      setTest(null);
    });
  };
  const showForm = !conn || editing;

  return (
    <div className="connection" aria-labelledby="calendar-h">
      <h3 id="calendar-h">Google Calendar</h3>
      {conn && <Status conn={conn} label="Service account" />}
      {conn?.destination && (
        <p>
          Events go to <strong>{conn.destination.title}</strong>. An event follows its booking: moved when the booking is rescheduled, deleted when it is cancelled.
        </p>
      )}
      {conn && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/google-calendar/test")))}>
            Add a test event
          </button>
          {!editing && (
            <button type="button" className="quiet" onClick={() => setEditing(true)}>
              Change calendar or key
            </button>
          )}
          <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm("Disconnect Google Calendar? Events stop following their bookings until you reconnect.") && void act(() => api("DELETE", "/settings/connections/google-calendar"))}>
            Disconnect
          </button>
        </div>
      )}
      <Outcome test={test} what="Google Calendar accepted a test event" />
      {showForm && (
        <form onSubmit={save}>
          <p>
            Daloy writes as a Google Cloud service account, so no personal Google sign-in is stored. Create a service account in a Google Cloud project with the Google Calendar API
            turned on, add a JSON key, then share your calendar with the account's email and choose Make changes to events.{" "}
            <a href={SERVICE_ACCOUNT_HELP} target="_blank" rel="noreferrer">
              How to create a service account
            </a>
          </p>
          <div className="field">
            <label htmlFor="c-key">Service account key file (JSON)</label>
            <textarea id="c-key" rows={4} value={form.serviceAccount} onChange={(e) => setForm({ ...form, serviceAccount: e.target.value })} required autoComplete="off" spellCheck={false} />
          </div>
          {shareWith && (
            <p className="muted">
              Share the calendar with <code>{shareWith}</code> and choose Make changes to events.
            </p>
          )}
          <div className="field">
            <label htmlFor="c-id">Calendar id</label>
            <input id="c-id" value={form.calendar} onChange={(e) => setForm({ ...form, calendar: e.target.value })} required placeholder="abc123@group.calendar.google.com" />
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {conn ? "Save calendar" : "Connect Google Calendar"}
            </button>
            {conn && (
              <button type="button" className="quiet" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </div>
  );
}

export function SlackConnection({ conn, onChange }: { conn: Connection | null; onChange: () => Promise<unknown> }) {
  const { t } = useLanguage();
  const { error, busy, act } = useAction(onChange);
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(false);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [channelId, setChannelId] = useState(conn?.destination?.channelId ?? "");
  const [test, setTest] = useState<TestResult | null>(null);
  const loadChannels = () => act(async () => setChannels(await api<Channel[]>("GET", "/settings/connections/slack/channels")));
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api("PUT", "/settings/connections/slack", { token });
      setToken("");
      setEditing(false);
    });
  };
  const chosen = channels?.find((c) => c.id === channelId);

  return (
    <div className="connection" aria-labelledby="slack-h">
      <h3 id="slack-h">Slack</h3>
      {conn && <Status conn={conn} label={t("Workspace")} />}
      {conn?.destination && (
        <p>{t("Notes go to ")}<strong>#{conn.destination.channelName}</strong>{t(". They carry the reference and subject only: names and emails stay in Daloy.")}</p>
      )}
      {conn && (
        <>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void loadChannels()}>
              {conn.destination ? t("Change channel") : t("Pick a channel")}
            </button>
            {conn.destination && (
              <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/slack/test")))}>{t("Send a test message")}</button>
            )}
            {!editing && (
              <button type="button" className="quiet" onClick={() => setEditing(true)}>{t("Replace token")}</button>
            )}
            <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm(t("Disconnect Slack? Automations stop sending there until you reconnect.")) && void act(() => api("DELETE", "/settings/connections/slack"))}>{t("Disconnect")}</button>
          </div>
          {channels && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api("PUT", "/settings/connections/slack/channel", { channelId });
                  setChannels(null);
                });
              }}
            >
              <div className="field">
                <label htmlFor="sl-channel">{t("Channel")}</label>
                <select id="sl-channel" value={channelId} onChange={(e) => setChannelId(e.target.value)} required>
                  <option value="">{t("Choose a public channel")}</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </select>
              </div>
              {chosen && !chosen.isMember && <p className="muted">{t("The app is not in #")}{chosen.name}{t(" yet. Type /invite and the app's name in that channel, or posts will fail.")}</p>}
              <div className="actions">
                <button type="submit" className="primary" disabled={busy}>{t("Save channel")}</button>
              </div>
            </form>
          )}
        </>
      )}
      <Outcome test={test} what={t("Slack accepted a test message")} />
      {(!conn || editing) && (
        <form onSubmit={save}>
          <p>{t("Create a Slack app for your workspace with the bot scopes ")}<code>chat:write</code>{t(" and ")}<code>channels:read</code>{t(", install it (your workspace may need an admin to approve it), and paste its Bot User OAuth Token.")}{" "}
            <a href={SLACK_APP_HELP} target="_blank" rel="noreferrer">{t("How to create a Slack app")}</a>
          </p>
          <div className="field">
            <label htmlFor="sl-token">{t("Bot token")}</label>
            <input id="sl-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} required placeholder="xoxb-…" autoComplete="off" />
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {conn ? t("Save token") : t("Connect Slack")}
            </button>
            {conn && (
              <button type="button" className="quiet" onClick={() => setEditing(false)}>{t("Cancel")}</button>
            )}
          </div>
        </form>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </div>
  );
}

export function PaymongoConnection({ conn, webhookBase, onChange }: { conn: Connection | null; webhookBase: string; onChange: () => Promise<unknown> }) {
  const { error, busy, act } = useAction(onChange);
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [form, setForm] = useState({ secretKey: "", webhookSecret: "" });
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api("PUT", "/settings/connections/paymongo", form);
      setForm({ secretKey: "", webhookSecret: "" });
      setEditing(false);
      setTest(null);
    });
  };

  return (
    <div className="connection" aria-labelledby="paymongo-h">
      <h3 id="paymongo-h">PayMongo</h3>
      {conn && <Status conn={conn} label="Key" />}
      {conn?.destination && (
        <>
          <p>
            <strong>{conn.destination.mode === "live" ? "Live mode" : "Test mode"}</strong>
          </p>
          <p>
            In PayMongo → Developers → Webhooks, add this URL with the events checkout_session.payment.paid and payment.refunded, then paste the webhook secret here.
          </p>
          <p>
            <code>{`${webhookBase}/${conn.destination.webhookPath}`}</code>{" "}
            <button type="button" className="quiet" onClick={() => void navigator.clipboard?.writeText(`${webhookBase}/${conn.destination!.webhookPath}`)}>
              Copy
            </button>
          </p>
        </>
      )}
      {conn && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/paymongo/test")))}>
            Test
          </button>
          {!editing && (
            <button type="button" className="quiet" onClick={() => setEditing(true)}>
              Replace key or secret
            </button>
          )}
          <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm("Disconnect PayMongo? Payment links stop working and payments are no longer recorded until you reconnect.") && void act(() => api("DELETE", "/settings/connections/paymongo"))}>
            Disconnect
          </button>
        </div>
      )}
      <Outcome test={test} what="PayMongo accepted the key" />
      {(!conn || editing) && (
        <form onSubmit={save}>
          <p>Paste your PayMongo secret key and the webhook secret. Both are stored encrypted and never shown again.</p>
          <div className="field">
            <label htmlFor="pm-key">Secret key</label>
            <input id="pm-key" type="password" value={form.secretKey} onChange={(e) => setForm({ ...form, secretKey: e.target.value })} required placeholder="sk_test_…" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="pm-whsk">Webhook secret</label>
            <input id="pm-whsk" type="password" value={form.webhookSecret} onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })} required placeholder="whsk_…" autoComplete="off" />
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {conn ? "Save" : "Connect PayMongo"}
            </button>
            {conn && (
              <button type="button" className="quiet" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </div>
  );
}

export function TelegramConnection({ conn, onChange }: { conn: Connection | null; onChange: () => Promise<unknown> }) {
  const { t } = useLanguage();
  const { error, busy, act } = useAction(onChange);
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [form, setForm] = useState({ token: "", chatId: conn?.destination?.chatId ?? "" });
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api("PUT", "/settings/connections/telegram", form);
      setForm({ ...form, token: "" });
      setEditing(false);
      setTest(null);
    });
  };

  return (
    <div className="connection" aria-labelledby="telegram-h">
      <h3 id="telegram-h">Telegram</h3>
      {conn && <Status conn={conn} label={t("Bot")} />}
      {conn?.destination && (
        <p>
          {t("Messages go to")} <strong>{conn.destination.chatTitle}</strong>. {t("Everyone in that chat can read them.")}
        </p>
      )}
      {conn && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/telegram/test")))}>
            {t("Send a test message")}
          </button>
          {!editing && (
            <button type="button" className="quiet" onClick={() => setEditing(true)}>
              {t("Replace token or chat")}
            </button>
          )}
          <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm(t("Disconnect Telegram? Automations stop sending there until you reconnect.")) && void act(() => api("DELETE", "/settings/connections/telegram"))}>
            {t("Disconnect")}
          </button>
        </div>
      )}
      <Outcome test={test} what={t("Telegram accepted a test message")} />
      {(!conn || editing) && (
        <form onSubmit={save}>
          <p>
            {t("Create a bot with BotFather in Telegram, add it to the chat, and send any message there. Paste the bot token and the chat id.")}{" "}
            <a href={TELEGRAM_BOT_HELP} target="_blank" rel="noreferrer">
              {t("How to create a Telegram bot")}
            </a>
          </p>
          <div className="field">
            <label htmlFor="tg-token">{t("Bot token")}</label>
            <input id="tg-token" type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} required placeholder="123456789:AA…" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="tg-chat">{t("Chat id")}</label>
            <input id="tg-chat" value={form.chatId} onChange={(e) => setForm({ ...form, chatId: e.target.value })} required placeholder="-1001234567890 or @channelname" autoComplete="off" />
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {conn ? t("Save") : t("Connect Telegram")}
            </button>
            {conn && (
              <button type="button" className="quiet" onClick={() => setEditing(false)}>
                {t("Cancel")}
              </button>
            )}
          </div>
        </form>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </div>
  );
}

export function OutlookConnection({ conn, setup, outcome, onChange }: { conn: Connection | null; setup: OutlookSetup; outcome?: string; onChange: () => Promise<unknown> }) {
  const { t } = useLanguage();
  const { error, busy, act } = useAction(onChange);
  const [test, setTest] = useState<TestResult | null>(null);
  const shown = outcome && setup.configured ? OUTLOOK_OUTCOMES[outcome] : undefined;
  // A full page visit to Microsoft. The callback brings the browser back here with the outcome in the address.
  const connect = () => act(async () => location.assign((await api<{ url: string }>("POST", "/settings/connections/outlook/start")).url));

  return (
    <div className="connection" aria-labelledby="outlook-h">
      <h3 id="outlook-h">Outlook</h3>
      {shown && (
        <p role={shown.ok ? "status" : "alert"} className={shown.ok ? "" : "message error"}>
          {t(shown.text)}
        </p>
      )}
      {!setup.configured ? (
        <p className="muted">{t("Outlook is not set up on this installation. The person who runs Daloy registers a free Microsoft Entra app and sets MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET (see the README). Email keeps going through the mail server in this installation's settings.")}</p>
      ) : (
        <>
          {conn && <Status conn={conn} label={t("Mailbox")} />}
          {conn && <p>{t("Purchase request emails go out from this mailbox, with a copy in its Sent Items.")}</p>}
          <p>{t("Microsoft will ask you to let Daloy send email as you (Mail.Send), keep that access without asking each time, and read your name and address. Many organizations only let an administrator approve a new app. If Microsoft says you need admin approval, send your administrator")}{" "}
            {setup.adminConsentUrl && (
              <a href={setup.adminConsentUrl} target="_blank" rel="noreferrer">{t("this approval link")}</a>
            )}{t(", then connect again.")}{" "}
            <a href={MICROSOFT_CONSENT_HELP} target="_blank" rel="noreferrer">{t("How organizations control app consent")}</a>
          </p>
          <div className="actions">
            <button type="button" className={conn ? "" : "primary"} disabled={busy} onClick={() => void connect()}>
              {conn ? t("Reconnect Outlook") : t("Connect Outlook")}
            </button>
            {conn && (
              <>
                <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/outlook/test")))}>{t("Send a test email to {email}", { email: conn.account })}
                </button>
                <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm(t("Disconnect Outlook? Automations stop sending there until you reconnect.")) && void act(() => api("DELETE", "/settings/connections/outlook"))}>{t("Disconnect")}</button>
              </>
            )}
          </div>
          <Outcome test={test} what={t("Outlook accepted a test email to the mailbox itself")} />
        </>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </div>
  );
}

export function TeamsConnection({ conn, onChange }: { conn: Connection | null; onChange: () => Promise<unknown> }) {
  const { t } = useLanguage();
  const { error, busy, act } = useAction(onChange);
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [form, setForm] = useState({ url: "", channelName: conn?.account ?? "" });
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api("PUT", "/settings/connections/teams", form);
      setForm({ ...form, url: "" });
      setEditing(false);
      setTest(null);
    });
  };

  return (
    <div className="connection" aria-labelledby="teams-h">
      <h3 id="teams-h">Microsoft Teams</h3>
      {conn && <Status conn={conn} label={t("Channel")} />}
      {conn && <p>{t("Notes carry the reference and the item only. They tell the channel what happened; approvals are answered in Daloy by the named approver.")}</p>}
      {conn && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/teams/test")))}>{t("Send a test message")}</button>
          {!editing && (
            <button type="button" className="quiet" onClick={() => setEditing(true)}>{t("Replace link")}</button>
          )}
          <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm(t("Disconnect Teams? Automations stop sending there until you reconnect.")) && void act(() => api("DELETE", "/settings/connections/teams"))}>{t("Disconnect")}</button>
        </div>
      )}
      {test?.ok ? (
        <p role="status">{t("Teams accepted the test message. Teams posts it a moment later: check that it is in ")}{conn?.account}.</p>
      ) : (
        <Outcome test={test} what="" />
      )}
      {(!conn || editing) && (
        <form onSubmit={save}>
          <p>{t("In Teams, open Workflows and create one from the template ")}<q>{t("Post to a channel when a webhook request is received")}</q>{t(". Choose the team and channel there, then copy the link it shows. Your organization may have to allow the Workflows app first; if the template is missing or blocked, ask your Teams administrator.")}{" "}
            <a href={TEAMS_WORKFLOWS_HELP} target="_blank" rel="noreferrer">{t("How to create the workflow")}</a>
          </p>
          <div className="field">
            <label htmlFor="tm-url">{t("Workflow link")}</label>
            <input id="tm-url" type="password" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required autoComplete="off" placeholder="https://…logic.azure.com/…" />
          </div>
          <div className="field">
            <label htmlFor="tm-channel">{t("Teams channel name, to show in Daloy")}</label>
            <input id="tm-channel" value={form.channelName} onChange={(e) => setForm({ ...form, channelName: e.target.value })} required maxLength={100} placeholder={t("Purchasing")} />
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {conn ? t("Save link") : t("Connect Teams")}
            </button>
            {conn && (
              <button type="button" className="quiet" onClick={() => setEditing(false)}>{t("Cancel")}</button>
            )}
          </div>
        </form>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- delivery status, for Requests and run details

export type Delivery = {
  id: string;
  provider: Provider;
  stepId: string;
  state: "queued" | "sending" | "delivered" | "needs_review" | "failed";
  checkFirst: boolean;
  attempts: number;
  result: Record<string, string | boolean> | null;
  lastError: string | null;
};

const NAMES: Record<Provider, string> = { google_sheets: "Sheet row", slack: "Slack note", outlook: "Outlook email", teams: "Teams note", telegram: "Telegram message", google_calendar: "Calendar event", paymongo: "PayMongo", airtable: "Airtable record", notion: "Notion page", trello: "Trello card" };

function describe(d: Delivery, t: ReturnType<typeof useLanguage>["t"]): string {
  switch (d.state) {
    case "queued":
      return d.attempts > 0 ? t("waiting to try again ({error})", { error: d.lastError ?? t("temporary problem") }) : t("queued");
    case "sending":
      return t("sending");
    case "delivered":
      if (d.result?.confirmedBy === "operator") return t(d.provider === "outlook" ? "marked as sent" : "marked as posted");
      // Older rows carry the range they were written to; newer ones the tab (decision 0021).
      if (d.result?.reconciled) return t("already in the sheet ({sheet}), not written twice", { sheet: String(d.result.sheet ?? d.result.range) });
      if (d.provider === "google_sheets") return t("added to {sheet}", { sheet: String(d.result?.sheet ?? d.result?.range ?? t("the sheet")) });
      if (d.provider === "google_calendar") return t(d.result?.event === "deleted" ? "event removed from the calendar" : d.result?.event === "updated" ? "event updated on the calendar" : "event added to the calendar");
      if (d.provider === "outlook") return t("sent to {email}", { email: String(d.result?.to ?? "") });
      return t(d.provider === "teams" ? "accepted by Teams" : "posted");
    case "needs_review":
      return d.lastError ?? t(d.provider === "outlook" ? "may have been sent" : "may have been posted");
    case "failed":
      return d.lastError ?? t("failed");
  }
}

/** Each delivery's state, with Retry for a failed one and Mark as posted (sent) or Post (Send) again for an uncertain one. */
export function DeliveryList({ deliveries, onChange }: { deliveries: Delivery[]; onChange: () => Promise<unknown> }) {
  const { t } = useLanguage();
  const { error, busy, act } = useAction(onChange);
  if (deliveries.length === 0) return null;
  return (
    <ul className="deliveries">
      {deliveries.map((d) => (
        <li key={d.id} data-state={d.state}>
          {t(NAMES[d.provider])}: {describe(d, t)}{" "}
          {d.state === "failed" && (
            <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => api("POST", `/deliveries/${d.id}/retry`, {}))}>
              {d.checkFirst ? t("Check and retry") : t("Retry")}
            </button>
          )}
          {d.state === "needs_review" && (
            <>
              <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => api("POST", `/deliveries/${d.id}/confirm`))}>{t(d.provider === "outlook" ? "Mark as sent" : "Mark as posted")}
              </button>
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => {
                  const ask = d.provider === "outlook" ? "Send this email again? If it already went out, the recipient gets it twice." : "Post this note again? If it is already in the channel, people will see it twice.";
                  if (window.confirm(t(ask))) void act(() => api("POST", `/deliveries/${d.id}/retry`, { postAgain: true }));
                }}
              >
                {d.provider === "outlook" ? t("Send again") : t("Post again")}
              </button>
            </>
          )}
        </li>
      ))}
      {error && (
        <li role="alert" className="message error">
          {error}
        </li>
      )}
    </ul>
  );
}

type RecordApp = {
  name: string;
  help: string;
  helpUrl: string;
  helpLink: string;
  fields: { key: string; label: string; secret?: boolean; placeholder: string }[];
  goesTo: (d: Record<string, string>) => string;
  testButton: string;
  testOk: string;
};
// Airtable, Notion and Trello add one record, page or card to the target saved here (decision 0046). Same shape, so one form.
const RECORD_APPS: Record<"airtable" | "notion" | "trello", RecordApp> = {
  airtable: {
    name: "Airtable",
    help: "Create a personal access token with the data.records:read and data.records:write scopes for your base. Paste it with the base id (app…) and the table id or name.",
    helpUrl: "https://airtable.com/create/tokens",
    helpLink: "Create an Airtable token",
    fields: [
      { key: "token", label: "Personal access token", secret: true, placeholder: "pat…" },
      { key: "baseId", label: "Base id", placeholder: "app…" },
      { key: "tableId", label: "Table id or name", placeholder: "tbl… or Requests" },
    ],
    goesTo: (d) => d.tableId ?? "",
    testButton: "Check the connection",
    testOk: "Airtable can read that table",
  },
  notion: {
    name: "Notion",
    help: "Create an internal integration, share your database with it, then paste its secret and the database link.",
    helpUrl: "https://www.notion.so/profile/integrations",
    helpLink: "Create a Notion integration",
    fields: [
      { key: "token", label: "Integration secret", secret: true, placeholder: "ntn_…" },
      { key: "database", label: "Database link or id", placeholder: "https://www.notion.so/…" },
    ],
    goesTo: (d) => d.databaseTitle ?? "",
    testButton: "Add a test page",
    testOk: "Notion accepted a test page",
  },
  trello: {
    name: "Trello",
    help: "Get your API key and a token from the Trello Power-Up admin page, then paste them with the id of the list that should get the cards.",
    helpUrl: "https://trello.com/power-ups/admin",
    helpLink: "Get a Trello key and token",
    fields: [
      { key: "key", label: "API key", placeholder: "32 letters and digits" },
      { key: "token", label: "Token", secret: true, placeholder: "ATTA…" },
      { key: "listId", label: "List id", placeholder: "24 letters and digits" },
    ],
    goesTo: (d) => d.listName ?? "",
    testButton: "Add a test card",
    testOk: "Trello accepted a test card",
  },
};

export function RecordConnection({ app, conn, onChange }: { app: keyof typeof RECORD_APPS; conn: Connection | null; onChange: () => Promise<unknown> }) {
  const { t } = useLanguage();
  const cfg = RECORD_APPS[app];
  const { error, busy, act } = useAction(onChange);
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api("PUT", `/settings/connections/${app}`, form);
      setForm({});
      setEditing(false);
      setTest(null);
    });
  };

  return (
    <div className="connection" aria-labelledby={`${app}-h`}>
      <h3 id={`${app}-h`}>{cfg.name}</h3>
      {conn && <Status conn={conn} label={t("Account")} />}
      {conn?.destination && (
        <p>
          {t("Entries are added to")} <strong>{cfg.goesTo(conn.destination)}</strong>.
        </p>
      )}
      {conn && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", `/settings/connections/${app}/test`)))}>
            {t(cfg.testButton)}
          </button>
          {!editing && (
            <button type="button" className="quiet" onClick={() => setEditing(true)}>
              {t("Replace token or target")}
            </button>
          )}
          <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm(t("Disconnect {app}? Automations stop adding there until you reconnect.", { app: cfg.name })) && void act(() => api("DELETE", `/settings/connections/${app}`))}>
            {t("Disconnect")}
          </button>
        </div>
      )}
      <Outcome test={test} what={t(cfg.testOk)} />
      {(!conn || editing) && (
        <form onSubmit={save}>
          <p>
            {t(cfg.help)}{" "}
            <a href={cfg.helpUrl} target="_blank" rel="noreferrer">
              {t(cfg.helpLink)}
            </a>
          </p>
          {cfg.fields.map((f) => (
            <div className="field" key={f.key}>
              <label htmlFor={`${app}-${f.key}`}>{t(f.label)}</label>
              <input id={`${app}-${f.key}`} type={f.secret ? "password" : "text"} value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} required placeholder={f.placeholder} autoComplete="off" />
            </div>
          ))}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {conn ? t("Save") : t("Connect {app}", { app: cfg.name })}
            </button>
            {conn && (
              <button type="button" className="quiet" onClick={() => setEditing(false)}>
                {t("Cancel")}
              </button>
            )}
          </div>
        </form>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </div>
  );
}
