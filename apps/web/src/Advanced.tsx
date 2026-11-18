import { Text, useLanguage } from "./Language";
import { useEffect, useState } from "react";
import { api, type Workflow } from "./api";
import { Header } from "./Nav";

/** #/advanced: everything for the person who runs the installation. The owner's home never needs it. */
export function AdvancedPage() {
  const { t } = useLanguage();
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
    <main className="page">
      <Header title={t("Advanced")} />
      <p className="muted">{t("For the person who runs this installation. Owners do not need this page to run their automations.")}</p>
      <h2><Text>Settings</Text></h2>
      <ul className="list">
        <li>
          <a href="#/settings/ai"><Text>AI model</Text></a> <span className="muted">{t("which model drafts and classifies, and its key")}</span>
        </li>
        <li>
          <a href="#/tokens"><Text>API tokens</Text></a> <span className="muted">{t("for MCP clients and scripts")}</span>
        </li>
        <li>
          <a href="#/secrets"><Text>Secrets</Text></a> <span className="muted">{t("for webhook signing and HTTP step keys")}</span>
        </li>
        <li>
          <a href="#/resources"><Text>Resources</Text></a> <span className="muted">{t("rooms, people and tables that bookings reserve")}</span>
        </li>
      </ul>
      <h2>{t("All automations")}</h2>
      <p className="muted">{t("To add one, use ")}<a href="#/new">{t("New automation")}</a>.
      </p>
      {listError && (
        <p role="alert" className="message error">{t("Couldn't load the automations. ")}<button type="button" onClick={() => void loadList()}><Text>Retry</Text></button>
        </p>
      )}
      {list === null ? (
        listError ? null : <p>{t("Loading…")}</p>
      ) : list.length === 0 ? (
        <p className="muted">{t("None yet.")}</p>
      ) : (
        <ul className="list">
          {list.map((w) => (
            <li key={w.id}>
              <a href={`#/w/${w.id}`}>{w.name}</a> <span className="muted">{w.slug}</span> <a href={`#/w/${w.id}/versions`}>{t("Versions")}</a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
