import { useState, type ReactNode } from "react";
import { useLanguage } from "./Language";
import { api } from "./api";
import type { Connection } from "./Connections";

export type OutcomeText = Record<string, { ok: boolean; text: string }>;

/** What the consent callback reported, by the code in #/apps/<slug>-<code> (decision 0058). {app} is the app's name. */
export const OAUTH_OUTCOMES: OutcomeText = {
  connected: { ok: true, text: "{app} is connected." },
  admin_approved: { ok: true, text: "An administrator approved Daloy for your organization. Connect {app} now." },
  admin_required: { ok: false, text: "{app} says an administrator has to approve Daloy first. Ask them, then connect again." },
  declined: { ok: false, text: "The permission request was declined, so nothing was connected. Connect again when you are ready." },
  missing_scope: { ok: false, text: "Some of the permissions Daloy asked for were not allowed, so nothing was connected. Connect again and allow all of them." },
  expired: { ok: false, text: "That sign-in took too long or was started by someone else. Start again with Connect {app}." },
  failed: { ok: false, text: "{app} did not finish connecting. Start again with Connect {app}." },
};

/** Runs one action at a time, shows its error, and reloads the page's data after it. */
export function useAction(onChange: () => Promise<unknown>) {
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

export function Status({ conn, label }: { conn: Connection; label: string }) {
  const { t } = useLanguage();
  return (
    <p className="in-use">
      {t(label)} <strong>{conn.account}</strong>
      <span className={`tag${conn.status === "active" ? " ok" : ""}`}>{conn.status === "active" ? t("Connected") : t("Needs reconnecting")}</span>
      {conn.lastError && <span className="message error"> {conn.lastError}</span>}
    </p>
  );
}

/**
 * One app's "Connect <App>" panel for the shared OAuth core (decision 0058): the outcome from the page address, the
 * connected account with its status and last error, Reconnect, Disconnect, and today's paste form under an Advanced
 * disclosure. Without a client on this installation, the paste form (or the unavailable note) is all it shows.
 */
export function ConnectPanel(p: {
  slug: string;
  name: string;
  configured: boolean;
  conn: Connection | null;
  /** The main button's text before connecting, when it differs from "Connect <name>" (Google: "Connect with Google"). */
  connectLabel?: string;
  /** The label before the account, such as Mailbox or Account. */
  label: string;
  outcome?: string;
  outcomes?: OutcomeText;
  /** Shown above the Connect button: what the app will ask for. */
  intro?: ReactNode;
  /** Extra buttons while connected, such as a test. */
  actions?: ReactNode;
  /** Shown below the buttons, such as a test result. */
  after?: ReactNode;
  /** Today's paste form: the advanced option when the app has a client, the only one when it does not. */
  form?: ReactNode;
  /** Shown instead when the app has no client and no paste form. */
  unavailable?: ReactNode;
  /** After Disconnect, when the provider did not confirm it removed Daloy's access. */
  removeHint?: string;
  onChange: () => Promise<unknown>;
  children?: ReactNode;
}) {
  const { t } = useLanguage();
  const { error, busy, act } = useAction(p.onChange);
  const [removed, setRemoved] = useState(false);
  const shown = p.outcome && p.configured ? (p.outcomes ?? OAUTH_OUTCOMES)[p.outcome] : undefined;
  // A full page visit to the provider. The callback brings the browser back to Apps with the outcome in the address.
  const connect = () => act(async () => location.assign((await api<{ url: string }>("POST", `/settings/connections/${p.slug}/oauth/start`)).url));
  const disconnect = () =>
    window.confirm(t("Disconnect {app}? Automations stop sending there until you reconnect.", { app: p.name })) &&
    void act(async () => {
      const out = await api<{ revoked: boolean } | undefined>("DELETE", `/settings/connections/${p.slug}`);
      setRemoved(out?.revoked !== true);
    });

  return (
    <div className="connection" aria-busy={busy} aria-labelledby={`${p.slug}-h`}>
      <h3 id={`${p.slug}-h`}>{p.name}</h3>
      {shown && (
        <p role={shown.ok ? "status" : "alert"} className={shown.ok ? "" : "message error"}>
          {t(shown.text, { app: p.name })}
        </p>
      )}
      {!p.configured ? (
        (p.form ?? p.unavailable)
      ) : (
        <>
          {p.conn && <Status conn={p.conn} label={t(p.label)} />}
          {p.children}
          {p.intro}
          <div className="actions">
            <button type="button" className={p.conn ? "" : "primary"} disabled={busy} onClick={() => void connect()}>
              {p.conn ? t("Reconnect {app}", { app: p.name }) : t(p.connectLabel ?? "Connect {app}", { app: p.name })}
            </button>
            {p.conn && (
              <>
                {p.actions}
                <button type="button" className="quiet" disabled={busy} onClick={disconnect}>{t("Disconnect")}</button>
              </>
            )}
          </div>
          {p.after}
          {removed && !p.conn && <p role="status">{t(p.removeHint ?? "Daloy deleted its access to {app}. {app} did not confirm that it removed Daloy, so remove Daloy in your {app} account settings too.", { app: p.name })}</p>}
          {p.form && (
            <details>
              <summary>{t("Advanced: use a key or token instead")}</summary>
              {p.form}
            </details>
          )}
        </>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </div>
  );
}
