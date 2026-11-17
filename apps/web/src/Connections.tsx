import { useState, type FormEvent } from "react";
import { api } from "./api";

export type Provider = "google_sheets" | "slack" | "outlook" | "teams" | "telegram";
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
  return (
    <p className="in-use">
      {label} <strong>{conn.account}</strong>
      <span className={`tag${conn.status === "active" ? " ok" : ""}`}>{conn.status === "active" ? "Connected" : "Needs reconnecting"}</span>
      {conn.lastError && <span className="message error"> {conn.lastError}</span>}
    </p>
  );
}

function Outcome({ test, what }: { test: TestResult | null; what: string }) {
  if (!test) return null;
  return test.ok ? (
    <p role="status">
      {what} {test.range ? `(${test.range})` : ""}. Check that it is there.
    </p>
  ) : (
    <p role="alert" className="message error">
      The test did not go through: {test.error}
    </p>
  );
}

export function SheetsConnection({ conn, onChange }: { conn: Connection | null; onChange: () => Promise<unknown> }) {
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
      {conn && <Status conn={conn} label="Service account" />}
      {conn?.destination && (
        <p>
          Rows go to <strong>{conn.destination.title}</strong>, tab <strong>{conn.destination.tab}</strong>. Column A holds the request reference, column B the time.
        </p>
      )}
      {conn && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/google-sheets/test")))}>
            Add a test row
          </button>
          {!editing && (
            <button type="button" className="quiet" onClick={() => setEditing(true)}>
              Change sheet or key
            </button>
          )}
          <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm("Disconnect Sheets? Automations stop sending there until you reconnect.") && void act(() => api("DELETE", "/settings/connections/google-sheets"))}>
            Disconnect
          </button>
        </div>
      )}
      <Outcome test={test} what="Google Sheets accepted a test row" />
      {showForm && (
        <form onSubmit={save}>
          <p>
            Daloy writes as a Google Cloud service account, so no personal Google sign-in is stored. Create a service account in a Google Cloud project with the Google Sheets API
            turned on, add a JSON key, then share your sheet with the account's email as an Editor.{" "}
            <a href={SERVICE_ACCOUNT_HELP} target="_blank" rel="noreferrer">
              How to create a service account
            </a>
          </p>
          <div className="field">
            <label htmlFor="s-key">Service account key file (JSON){conn ? ", leave empty to keep the current key" : ""}</label>
            <textarea id="s-key" rows={4} value={form.serviceAccount} onChange={(e) => setForm({ ...form, serviceAccount: e.target.value })} required={!conn} autoComplete="off" spellCheck={false} />
          </div>
          {shareWith && (
            <p className="muted">
              Share the sheet with <code>{shareWith}</code> as an Editor.
            </p>
          )}
          <div className="field">
            <label htmlFor="s-sheet">Sheet link</label>
            <input id="s-sheet" value={form.sheet} onChange={(e) => setForm({ ...form, sheet: e.target.value })} required placeholder="https://docs.google.com/spreadsheets/d/…" />
          </div>
          <div className="field">
            <label htmlFor="s-tab">Tab name</label>
            <input id="s-tab" value={form.tab} onChange={(e) => setForm({ ...form, tab: e.target.value })} required maxLength={100} />
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {conn ? "Save sheet" : "Connect Google Sheets"}
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
      {conn && <Status conn={conn} label="Workspace" />}
      {conn?.destination && (
        <p>
          Notes go to <strong>#{conn.destination.channelName}</strong>. They carry the reference and subject only: names and emails stay in Daloy.
        </p>
      )}
      {conn && (
        <>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void loadChannels()}>
              {conn.destination ? "Change channel" : "Pick a channel"}
            </button>
            {conn.destination && (
              <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/slack/test")))}>
                Send a test message
              </button>
            )}
            {!editing && (
              <button type="button" className="quiet" onClick={() => setEditing(true)}>
                Replace token
              </button>
            )}
            <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm("Disconnect Slack? Automations stop sending there until you reconnect.") && void act(() => api("DELETE", "/settings/connections/slack"))}>
              Disconnect
            </button>
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
                <label htmlFor="sl-channel">Channel</label>
                <select id="sl-channel" value={channelId} onChange={(e) => setChannelId(e.target.value)} required>
                  <option value="">Choose a public channel</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </select>
              </div>
              {chosen && !chosen.isMember && <p className="muted">The app is not in #{chosen.name} yet. Type /invite and the app's name in that channel, or posts will fail.</p>}
              <div className="actions">
                <button type="submit" className="primary" disabled={busy}>
                  Save channel
                </button>
              </div>
            </form>
          )}
        </>
      )}
      <Outcome test={test} what="Slack accepted a test message" />
      {(!conn || editing) && (
        <form onSubmit={save}>
          <p>
            Create a Slack app for your workspace with the bot scopes <code>chat:write</code> and <code>channels:read</code>, install it (your workspace may need an admin to approve
            it), and paste its Bot User OAuth Token.{" "}
            <a href={SLACK_APP_HELP} target="_blank" rel="noreferrer">
              How to create a Slack app
            </a>
          </p>
          <div className="field">
            <label htmlFor="sl-token">Bot token</label>
            <input id="sl-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} required placeholder="xoxb-…" autoComplete="off" />
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {conn ? "Save token" : "Connect Slack"}
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
      {conn && <Status conn={conn} label="Bot" />}
      {conn?.destination && (
        <p>
          Messages go to <strong>{conn.destination.chatTitle}</strong>. Everyone in that chat can read them.
        </p>
      )}
      {conn && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/telegram/test")))}>
            Send a test message
          </button>
          {!editing && (
            <button type="button" className="quiet" onClick={() => setEditing(true)}>
              Replace token or chat
            </button>
          )}
          <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm("Disconnect Telegram? Automations stop sending there until you reconnect.") && void act(() => api("DELETE", "/settings/connections/telegram"))}>
            Disconnect
          </button>
        </div>
      )}
      <Outcome test={test} what="Telegram accepted a test message" />
      {(!conn || editing) && (
        <form onSubmit={save}>
          <p>
            Create a bot with BotFather in Telegram, add it to the chat, and send any message there. Paste the bot token and the chat id.{" "}
            <a href={TELEGRAM_BOT_HELP} target="_blank" rel="noreferrer">
              How to create a Telegram bot
            </a>
          </p>
          <div className="field">
            <label htmlFor="tg-token">Bot token</label>
            <input id="tg-token" type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} required placeholder="123456789:AA…" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="tg-chat">Chat id</label>
            <input id="tg-chat" value={form.chatId} onChange={(e) => setForm({ ...form, chatId: e.target.value })} required placeholder="-1001234567890 or @channelname" autoComplete="off" />
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {conn ? "Save" : "Connect Telegram"}
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

export function OutlookConnection({ conn, setup, outcome, onChange }: { conn: Connection | null; setup: OutlookSetup; outcome?: string; onChange: () => Promise<unknown> }) {
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
          {shown.text}
        </p>
      )}
      {!setup.configured ? (
        <p className="muted">
          Outlook is not set up on this installation. The person who runs Daloy registers a free Microsoft Entra app and sets MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET (see
          the README). Email keeps going through the mail server in this installation's settings.
        </p>
      ) : (
        <>
          {conn && <Status conn={conn} label="Mailbox" />}
          {conn && <p>Purchase request emails go out from this mailbox, with a copy in its Sent Items.</p>}
          <p>
            Microsoft will ask you to let Daloy send email as you (Mail.Send), keep that access without asking each time, and read your name and address. Many organizations only
            let an administrator approve a new app. If Microsoft says you need admin approval, send your administrator{" "}
            {setup.adminConsentUrl && (
              <a href={setup.adminConsentUrl} target="_blank" rel="noreferrer">
                this approval link
              </a>
            )}
            , then connect again.{" "}
            <a href={MICROSOFT_CONSENT_HELP} target="_blank" rel="noreferrer">
              How organizations control app consent
            </a>
          </p>
          <div className="actions">
            <button type="button" className={conn ? "" : "primary"} disabled={busy} onClick={() => void connect()}>
              {conn ? "Reconnect Outlook" : "Connect Outlook"}
            </button>
            {conn && (
              <>
                <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/outlook/test")))}>
                  Send a test email to {conn.account}
                </button>
                <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm("Disconnect Outlook? Automations stop sending there until you reconnect.") && void act(() => api("DELETE", "/settings/connections/outlook"))}>
                  Disconnect
                </button>
              </>
            )}
          </div>
          <Outcome test={test} what="Outlook accepted a test email to the mailbox itself" />
        </>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </div>
  );
}

export function TeamsConnection({ conn, onChange }: { conn: Connection | null; onChange: () => Promise<unknown> }) {
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
      {conn && <Status conn={conn} label="Channel" />}
      {conn && <p>Notes carry the reference and the item only. They tell the channel what happened; approvals are answered in Daloy by the named approver.</p>}
      {conn && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/teams/test")))}>
            Send a test message
          </button>
          {!editing && (
            <button type="button" className="quiet" onClick={() => setEditing(true)}>
              Replace link
            </button>
          )}
          <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm("Disconnect Teams? Automations stop sending there until you reconnect.") && void act(() => api("DELETE", "/settings/connections/teams"))}>
            Disconnect
          </button>
        </div>
      )}
      {test?.ok ? (
        <p role="status">Teams accepted the test message. Teams posts it a moment later: check that it is in {conn?.account}.</p>
      ) : (
        <Outcome test={test} what="" />
      )}
      {(!conn || editing) && (
        <form onSubmit={save}>
          <p>
            In Teams, open Workflows and create one from the template <q>Post to a channel when a webhook request is received</q>. Choose the team and channel there, then copy the
            link it shows. Your organization may have to allow the Workflows app first; if the template is missing or blocked, ask your Teams administrator.{" "}
            <a href={TEAMS_WORKFLOWS_HELP} target="_blank" rel="noreferrer">
              How to create the workflow
            </a>
          </p>
          <div className="field">
            <label htmlFor="tm-url">Workflow link</label>
            <input id="tm-url" type="password" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required autoComplete="off" placeholder="https://…logic.azure.com/…" />
          </div>
          <div className="field">
            <label htmlFor="tm-channel">Teams channel name, to show in Daloy</label>
            <input id="tm-channel" value={form.channelName} onChange={(e) => setForm({ ...form, channelName: e.target.value })} required maxLength={100} placeholder="Purchasing" />
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {conn ? "Save link" : "Connect Teams"}
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

const NAMES: Record<Provider, string> = { google_sheets: "Sheet row", slack: "Slack note", outlook: "Outlook email", teams: "Teams note", telegram: "Telegram message" };
const sent = (p: Provider) => (p === "outlook" ? "sent" : "posted");

function describe(d: Delivery): string {
  switch (d.state) {
    case "queued":
      return d.attempts > 0 ? `waiting to try again (${d.lastError ?? "temporary problem"})` : "queued";
    case "sending":
      return "sending";
    case "delivered":
      if (d.result?.confirmedBy === "operator") return `marked as ${sent(d.provider)}`;
      // Older rows carry the range they were written to; newer ones the tab (decision 0021).
      if (d.result?.reconciled) return `already in the sheet (${String(d.result.sheet ?? d.result.range)}), not written twice`;
      if (d.provider === "google_sheets") return `added to ${String(d.result?.sheet ?? d.result?.range ?? "the sheet")}`;
      if (d.provider === "outlook") return `sent to ${String(d.result?.to ?? "")}`;
      return d.provider === "teams" ? "accepted by Teams" : "posted";
    case "needs_review":
      return d.lastError ?? `may have been ${sent(d.provider)}`;
    case "failed":
      return d.lastError ?? "failed";
  }
}

/** Each delivery's state, with Retry for a failed one and Mark as posted (sent) or Post (Send) again for an uncertain one. */
export function DeliveryList({ deliveries, onChange }: { deliveries: Delivery[]; onChange: () => Promise<unknown> }) {
  const { error, busy, act } = useAction(onChange);
  if (deliveries.length === 0) return null;
  return (
    <ul className="deliveries">
      {deliveries.map((d) => (
        <li key={d.id} data-state={d.state}>
          {NAMES[d.provider]}: {describe(d)}{" "}
          {d.state === "failed" && (
            <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => api("POST", `/deliveries/${d.id}/retry`, {}))}>
              {d.checkFirst ? "Check and retry" : "Retry"}
            </button>
          )}
          {d.state === "needs_review" && (
            <>
              <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => api("POST", `/deliveries/${d.id}/confirm`))}>
                Mark as {sent(d.provider)}
              </button>
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => {
                  const ask = d.provider === "outlook" ? "Send this email again? If it already went out, the recipient gets it twice." : "Post this note again? If it is already in the channel, people will see it twice.";
                  if (window.confirm(ask)) void act(() => api("POST", `/deliveries/${d.id}/retry`, { postAgain: true }));
                }}
              >
                {d.provider === "outlook" ? "Send again" : "Post again"}
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
