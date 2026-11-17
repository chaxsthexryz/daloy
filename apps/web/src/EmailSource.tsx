import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "./api";

type Source = {
  host: string;
  username: string;
  folder: string;
  status: "pending" | "active" | "failed" | "disconnected";
  listening: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
};
type Response = { source: Source | null };

/** Credentials live only in the unsaved password input. Polling reads the sanitized mailbox status. */
export function EmailSource({ workflowId, published }: { workflowId: string; published: boolean }) {
  const id = useId();
  const path = `/workflows/${workflowId}/email-source`;
  const [source, setSource] = useState<Source | null>(null);
  const [form, setForm] = useState({ host: "", username: "", password: "", folder: "INBOX" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const writes = useRef(0);
  const writing = useRef(false);

  useEffect(() => {
    let mounted = true;
    let initialized = false;
    const load = async () => {
      if (writing.current) return;
      const revision = writes.current;
      try {
        const { source: current } = await api<Response>("GET", path);
        if (!mounted || writing.current || revision !== writes.current) return;
        setSource(current);
        setLoaded(true);
        if (!initialized && current) setForm({ host: current.host, username: current.username, password: "", folder: current.folder });
        initialized = true;
      } catch (e) {
        if (mounted && !writing.current && revision === writes.current) setError((e as Error).message);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [path]);

  const act = async (action: () => Promise<void>) => {
    writes.current += 1;
    writing.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };
  const connect = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      try {
        const result = await api<Response>("PUT", path, form);
        setSource(result.source);
      } finally {
        setForm((current) => ({ ...current, password: "" }));
      }
    });
  };
  return (
    <section aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Email inbox</h3>
      <p>
        Connect a dedicated mailbox or folder that receives your website form emails. Daloy checks it over IMAP with TLS. It reads messages
        without marking them read or deleting them. Attachments are ignored.
      </p>
      <p>
        Existing mail is skipped on the first connection and when an email trigger is first published. After publishing, wait for the
        worker's first mailbox check before sending a new test email. Treat incoming email as untrusted text.
      </p>
      <p role="status">Mailbox status: {loaded ? (source?.status ?? "Not connected") : "Loading"}</p>
      {source?.status === "active" && (
        <p role="status">
          {source.listening
            ? "Listening for new mail"
            : published
              ? "Starting mailbox listening. Wait for Listening for new mail before sending a test email."
              : "Mailbox checked. Publish the email trigger and wait for Listening for new mail before sending a test email."}
        </p>
      )}
      {source?.lastCheckedAt && <p>Last checked: {new Date(source.lastCheckedAt).toLocaleString()}</p>}
      {source?.lastError && <p role="alert">{source.lastError}</p>}
      {error && <p role="alert">{error}</p>}
      <form onSubmit={connect}>
        <fieldset disabled={!loaded || busy}>
          <legend className="visually-hidden">Mailbox connection</legend>
          <div className="field">
            <label htmlFor={`${id}-host`}>IMAP host</label>
            <input
              id={`${id}-host`}
              required
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              autoComplete="off"
              placeholder="imap.gmail.com"
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-username`}>Mailbox username</label>
            <input
              id={`${id}-username`}
              required
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-password`}>Mailbox app password</label>
            <input
              id={`${id}-password`}
              type="password"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-folder`}>Mailbox folder</label>
            <input id={`${id}-folder`} required value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} />
          </div>
          <button type="submit" disabled={busy}>
            Connect mailbox
          </button>
        </fieldset>
      </form>
      {source && source.status !== "disconnected" && (
        <div className="actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(async () => setSource((await api<Response>("POST", `${path}/check`)).source))}
          >
            Check mailbox status{source.status === "failed" ? " and restart from new mail if the mailbox changed" : ""}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api("DELETE", path);
                setForm((current) => ({ ...current, password: "" }));
                setSource((await api<Response>("GET", path)).source);
              })
            }
          >
            Disconnect mailbox
          </button>
        </div>
      )}
      <p>
        Use {"{{trigger.from}}"}, {"{{trigger.replyTo}}"}, {"{{trigger.subject}}"}, {"{{trigger.text}}"}, {"{{trigger.messageId}}"} and{" "}
        {"{{trigger.receivedAt}}"} in steps. The recipient list is {"{{trigger.to}}"}. The sender address does not prove who sent it.
      </p>
    </section>
  );
}
