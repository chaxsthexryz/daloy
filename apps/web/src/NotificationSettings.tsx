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
      <h2 className="wk-card-head" id="notifications-card"><b>{t("Notifications")}</b></h2>
      <fieldset className="wk-body wk-radios" disabled={!prefs}>
        <legend className="wk-sr">{t("Notifications")}</legend>
        {ROWS.map(([key, label, note]) => (
          <label key={key}>
            <input type="checkbox" checked={prefs?.[key] ?? false} onChange={(e) => void change(key, e.target.checked)} /> {t(label)}
            {note && <span className="wk-muted"> {t(note)}</span>}
          </label>
        ))}
        <p className="wk-muted">{t("Choose what appears in the bell and as pop-ups. These choices are only for you.")}</p>
        {error && <p role="alert" className="wk-note bad">{t("Could not save your choices.")}</p>}
      </fieldset>
    </section>
  );
}
