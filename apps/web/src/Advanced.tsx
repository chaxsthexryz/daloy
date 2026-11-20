import "./workspace.css";
import { useEffect, useState } from "react";
import { api, type Workflow } from "./api";
import { useLanguage } from "./Language";
import { usePhone } from "./Sheet";

// The owner's own tools. The icons come from the shared sprite (navigation.svg).
const TOOLS: [href: string, name: string, note: string, icon: string][] = [
  ["#/settings/ai", "AI model", "which model drafts and classifies, and its key", "ai"],
  ["#/tokens", "API tokens", "for MCP clients and scripts", "key"],
  ["#/secrets", "Secrets", "for webhook signing and HTTP step keys", "lock"],
  ["#/resources", "Resources", "rooms, people and tables that bookings reserve", "bookings"],
];

/** #/advanced: everything for the person who runs the installation (Doop row W5). Owner only: App.tsx sends anyone else to Automations. */
export function AdvancedPage() {
  const { t } = useLanguage();
  const phone = usePhone();
  const [list, setList] = useState<Workflow[] | null>(null);
  const [listError, setListError] = useState(false);
  const loadList = () =>
    api<Workflow[]>("GET", "/workflows").then(
      (l) => {
        setListError(false);
        setList(l);
      },
      () => setListError(true),
    );
  useEffect(() => void loadList(), []);

  return (
    <main className="page wk wk-advanced">
      <header className="wk-head">
        <div className={phone ? undefined : "wk-title-row"}>
          <a className="wk-back wk-back-quiet" href="#/settings">{t("Menu")}</a>
          <h1>{t("Advanced")}</h1>
        </div>
      </header>
      <p className="wk-sub">{t("For the person who runs this installation. Owners do not need this page to run their automations.")}</p>
      <section className="wk-card" aria-labelledby="advanced-settings">
        <h2 className="wk-card-head" id="advanced-settings"><b>{t("Settings")}</b></h2>
        <ul className="wk-rows wk-dir">
          {TOOLS.map(([href, name, note, icon]) => (
            <li key={href} className="wk-dir-row">
              <span className="wk-dir-name">
                <span className="wk-icon" aria-hidden="true"><svg><use href={`/navigation.svg#${icon}`} /></svg></span>
                <a href={href}>{t(name)}</a>
              </span>
              <small>{t(note)}</small>
              <span className="wk-dir-open" aria-hidden="true">{t("Open")}</span>
            </li>
          ))}
        </ul>
      </section>
      <div className="wk-title-row wk-subhead">
        <h2>{t("All automations")}</h2>
        <p className="wk-sub">{t("To add one, use ")}<a href="#/new">{t("New automation")}</a>.</p>
      </div>
      {listError && (
        <p role="alert" className="wk-note bad">{t("Couldn't load the automations. ")}<button type="button" className="wk-button" onClick={() => void loadList()}>{t("Retry")}</button></p>
      )}
      {list === null ? (
        listError ? null : <p className="wk-sub" role="status">{t("Loading…")}</p>
      ) : list.length === 0 ? (
        <p className="wk-sub">{t("None yet.")}</p>
      ) : (
        <ul className="wk-card wk-rows wk-dir wk-dir-flows">
          {list.map((w) => (
            <li key={w.id} className="wk-dir-row">
              <a className="wk-ink" href={`#/w/${w.id}`}>{w.name}</a>
              <small>{w.slug}</small>
              <a className="wk-dir-open" href={`#/w/${w.id}/versions`} aria-label={t("Versions of {name}", { name: w.name })}>{t("Versions")}</a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
