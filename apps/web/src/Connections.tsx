import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

type Provider = "google_sheets" | "slack";
type Connection = { provider: Provider; status: "active" | "failed"; account: string; destination: Record<string, string> | null; lastError: string | null; lastTestedAt: string | null };
type TestResult = { ok: true; range?: string; channel?: string } | { ok: false; error: string };
type Channel = { id: string; name: string; isMember: boolean };

const SERVICE_ACCOUNT_HELP = "https://cloud.google.com/iam/docs/service-accounts-create";
const SLACK_APP_HELP = "https://api.slack.com/quickstart";

/** Business and email, Connections: Google Sheets and Slack for office requests (roadmap phase 3). */
export function ConnectionsSection() {
  const [list, setList] = useState<Connection[] | null>(null);
  const [error, setError] = useState("");
  const load = () => api<{ connections: Connection[] }>("GET", "/settings/connections").then((r) => setList(r.connections), (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const of = (p: Provider) => list?.find((c) => c.provider === p) ?? null;

  return (
    <section aria-labelledby="connections-h">
      <h2 id="connections-h">Connections</h2>
      <p>
        Office requests can also add a row to a Google Sheet and post a short note to a Slack channel. Both are optional. Each delivery is tracked on its own, so a Slack problem never
        holds up the sheet, and the local demo works without either.
      </p>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {list && (
        <>
          <SheetsConnection conn={of("google_sheets")} onChange={load} />
          <SlackConnection conn={of("slack")} onChange={load} />
        </>
      )}
    </section>
  );
}

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

function SheetsConnection({ conn, onChange }: { conn: Connection | null; onChange: () => Promise<unknown> }) {
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
          <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => api("DELETE", "/settings/connections/google-sheets"))}>
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

function SlackConnection({ conn, onChange }: { conn: Connection | null; onChange: () => Promise<unknown> }) {
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
            <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => api("DELETE", "/settings/connections/slack"))}>
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

const NAMES: Record<Provider, string> = { google_sheets: "Sheet row", slack: "Slack note" };

function describe(d: Delivery): string {
  switch (d.state) {
    case "queued":
      return d.attempts > 0 ? `waiting to try again (${d.lastError ?? "temporary problem"})` : "queued";
    case "sending":
      return "sending";
    case "delivered":
      if (d.result?.confirmedBy === "operator") return "marked as posted";
      if (d.result?.reconciled) return `found in the sheet (${String(d.result.range)}), not written twice`;
      return d.provider === "google_sheets" ? `added (${String(d.result?.range ?? "")})` : "posted";
    case "needs_review":
      return d.lastError ?? "may have been posted";
    case "failed":
      return d.lastError ?? "failed";
  }
}

/** Each delivery's state, with Retry for a failed one and Mark as posted or Post again for an uncertain Slack note. */
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
                Mark as posted
              </button>
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Post this note again? If it is already in the channel, people will see it twice.")) void act(() => api("POST", `/deliveries/${d.id}/retry`, { postAgain: true }));
                }}
              >
                Post again
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
