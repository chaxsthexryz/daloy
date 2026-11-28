import { useEffect, useState } from "react";
import { api } from "./api";
import { useLanguage } from "./Language";

type Prefs = { chats: boolean; handoff: boolean; runsSucceeded: boolean; runsFailed: boolean };
const ROWS: [key: keyof Prefs, label: string, note?: string][] = [
  ["chats", "New customer chats"],
  ["handoff", "A guest asks for a person"],
  ["runsSucceeded", "Successful live runs", "Off by default, because a busy workspace would fill the bell."],
  ["runsFailed", "Failed live runs"],
];

/** The four bell switches for the signed-in owner or operator (decision 0155). Each change saves at once. */
export function NotificationsCard() {
  const { t } = useLanguage();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    api<Prefs>("GET", "/settings/notifications").then(setPrefs, () => setError(true));
  }, []);
  const change = async (key: keyof Prefs, value: boolean) => {
    if (!prefs) return;
    const before = prefs;
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    setError(false);
    try {
      setPrefs(await api<Prefs>("PUT", "/settings/notifications", next));
    } catch {
      setPrefs(before);
      setError(true);
    }
  };
  return (
    <section className="wk-card" aria-labelledby="notifications-card">
      <h2 className="wk-card-head" id="notifications-card"><span className="wk-card-title-group"><span className="card-ico" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg></span><b>{t("Notifications")}</b></span></h2>
      <fieldset className="wk-body wk-switch-list" disabled={!prefs}>
        <legend className="wk-sr">{t("Notifications")}</legend>
        {ROWS.map(([key, label, note]) => (
          <label key={key} className="wk-switch-row">
            <span className="wk-switch-copy">
              <span>{t(label)}</span>
              {note && <small>{t(note)}</small>}
            </span>
            <input type="checkbox" className="wk-switch-input" checked={prefs?.[key] ?? false} onChange={(e) => void change(key, e.target.checked)} />
          </label>
        ))}
        <p className="wk-muted">{t("Choose what appears in the bell and as pop-ups. These choices are only for you.")}</p>
        {error && <p role="alert" className="wk-note bad">{t("Could not save your choices.")}</p>}
      </fieldset>
    </section>
  );
}
