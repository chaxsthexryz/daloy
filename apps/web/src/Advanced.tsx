import { useEffect, useState } from "react";
import { api, type Workflow } from "./api";
import { Header } from "./Nav";

/** #/advanced: everything for the person who runs the installation. The owner's home never needs it. */
export function AdvancedPage() {
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
      <Header title="Advanced" />
      <p className="muted">For the person who runs this installation. Owners do not need this page to run their automations.</p>
      <h2>Settings</h2>
      <ul className="list">
        <li>
          <a href="#/settings/ai">AI model</a> <span className="muted">which model drafts and classifies, and its key</span>
        </li>
        <li>
          <a href="#/tokens">API tokens</a> <span className="muted">for MCP clients and scripts</span>
        </li>
        <li>
          <a href="#/resources">Resources</a> <span className="muted">rooms, people and tables that bookings reserve</span>
        </li>
      </ul>
      <h2>All automations</h2>
      <p className="muted">
        To add one, use <a href="#/new">New automation</a>.
      </p>
      {listError && (
        <p role="alert" className="message error">
          Couldn't load the automations. <button type="button" onClick={() => void loadList()}>Retry</button>
        </p>
      )}
      {list === null ? (
        listError ? null : <p>Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="list">
          {list.map((w) => (
            <li key={w.id}>
              <a href={`#/w/${w.id}`}>{w.name}</a> <span className="muted">{w.slug}</span> <a href={`#/w/${w.id}/versions`}>Versions</a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
