import { TEMPLATES } from "@daloy/engine";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Workflow } from "./api";
import { BuildWithAi } from "./AiDraft";
import { Header } from "./Nav";
import type { User } from "./Team";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

/** #/advanced: everything for the person who runs the installation. The owner's home never needs it. */
export function AdvancedPage({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [list, setList] = useState<Workflow[] | null>(null);
  const [listError, setListError] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState("");
  const loadList = () =>
    api<Workflow[]>("GET", "/workflows").then(
      (l) => {
        setListError(false);
        setList(l);
      },
      () => setListError(true),
    );
  useEffect(() => void loadList(), []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const wf = await api<Workflow>("POST", "/workflows", { name, slug: slugify(name) || "workflow" });
      const t = TEMPLATES.find((t) => t.slug === template);
      if (t) await api("POST", `/workflows/${wf.id}/versions`, { definition: t.definition, publish: false });
      location.hash = `#/w/${wf.id}`;
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "A workflow with that name already exists." : (err as Error).message);
    }
  };

  return (
    <main className="page">
      <Header title="Advanced" user={user} onSignOut={onSignOut} />
      <p className="muted">For the person who runs this installation. Owners do not need this page to run their automations.</p>
      <h2>Settings</h2>
      <ul className="list">
        <li>
          <a href="#/settings">AI model</a> <span className="muted">which model drafts and classifies, and its key</span>
        </li>
        <li>
          <a href="#/tokens">API tokens</a> <span className="muted">for MCP clients and scripts</span>
        </li>
        <li>
          <a href="#/resources">Resources</a> <span className="muted">rooms, people and tables that bookings reserve</span>
        </li>
      </ul>
      <form onSubmit={create} className="create">
        <h2>New workflow</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="wf-name">Name</label>
            <input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="wf-template">Start from</label>
            <select id="wf-template" value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="">Blank workflow</option>
              {TEMPLATES.map((t) => (
                <option key={t.slug} value={t.slug}>
                  Template: {t.name}
                </option>
              ))}
            </select>
          </div>
          <button className="primary">Create</button>
        </div>
        {template && <p className="muted hint">{TEMPLATES.find((t) => t.slug === template)!.description}</p>}
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
      </form>
      <BuildWithAi />
      <h2>All workflows</h2>
      {listError && (
        <p role="alert" className="message error">
          Couldn't load the workflows. <button type="button" onClick={() => void loadList()}>Retry</button>
        </p>
      )}
      {list === null ? (
        listError ? null : <p>Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">None yet. Create one above.</p>
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
