import { useEffect, useState } from "react";
import { api, type RunSummary, type Workflow } from "./api";
import { Header } from "./Nav";
import { FormEmbed } from "./FormEmbed";
import { arrange, type Filter } from "./lib/automations";
import { lastEvent, plainState } from "./lib/states";
import type { User } from "./Team";

const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["needs_you", "Needs you"],
  ["problem", "Problem"],
  ["waiting", "Waiting"],
  ["off", "Off"],
];

/** Home: one card per automation with its state, last event and the few things an owner does with it. */
export function Automations({ user }: { user: User }) {
  const owner = user.role === "owner";
  const [list, setList] = useState<Workflow[] | null>(null);
  const [listError, setListError] = useState(false);
  const [review, setReview] = useState<RunSummary[]>([]);
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const load = () => {
    api<Workflow[]>("GET", "/workflows").then(
      (l) => {
        setListError(false);
        setList(l);
      },
      () => setListError(true),
    );
    // Best effort: the strip is a pointer, so a failure here leaves it out instead of blocking the page.
    api<RunSummary[]>("GET", "/runs?review=true").then(setReview, () => setReview([]));
  };
  useEffect(load, []);

  const copy = (id: string, formId: string) => {
    const link = `${location.origin}/forms/${formId}`;
    navigator.clipboard.writeText(link).then(
      () => setCopied(`Form link copied for ${list?.find((w) => w.id === id)?.name ?? "this automation"}.`),
      () => setCopied(`Copy this link: ${link}`),
    );
  };

  const remove = async (w: Workflow) => {
    if (!window.confirm(`Delete the draft "${w.name}"? This cannot be undone.`)) return;
    setError("");
    try {
      await api("DELETE", `/workflows/${w.id}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const { shown, drafts } = arrange(list ?? [], query, filter);

  return (
    <main className="page">
      <Header title="Automations" action={owner && <a className="primary" href="#/new">New automation</a>} />
      {review.length > 0 && (
        <p role="status" className="needs-you">
          <strong>{review.length >= 50 ? "50 or more" : review.length}</strong> {review.length === 1 ? "request needs" : "requests need"} you.{" "}
          <a href={`#/runs/${review[review.length - 1]!.id}`}>Open the oldest</a>
        </p>
      )}
      <p role="status" className="muted" hidden={!copied}>
        {copied}
      </p>
      {listError && (
        <p role="alert" className="message error">
          Couldn't load your automations. <button type="button" onClick={load}>Retry</button>
        </p>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {list === null ? (
        listError ? null : <p>Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">{owner ? <>No automations yet. <a href="#/new">Add your first one</a>.</> : "No automations yet."}</p>
      ) : (
        <>
          <div className="filters">
            <div className="field">
              <label htmlFor="find">Find an automation</label>
              <input id="find" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="actions" role="group" aria-label="Show">
              {FILTERS.map(([key, label]) => (
                <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <p className="muted">None match.</p>
          ) : (
            <ul className="cards">
              {shown.map((w) => (
                <Card key={w.id} w={w} onCopy={copy} />
              ))}
            </ul>
          )}
          {drafts.length > 0 && (
            <details className="drafts">
              <summary>Drafts ({drafts.length})</summary>
              <ul className="list">
                {drafts.map((w) => (
                  <li key={w.id}>
                    <a href={`#/a/${w.id}`}>{w.name}: continue setup</a> <span className="muted">started {new Date(w.createdAt).toLocaleDateString()}</span>{" "}
                    {owner && (
                      <button type="button" className="quiet" onClick={() => void remove(w)}>
                        Delete
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </main>
  );
}

function Card({ w, onCopy }: { w: Workflow; onCopy: (id: string, formId: string) => void }) {
  const state = w.last ? plainState(w.last) : null;
  return (
    <li className="card">
      <div className="card-head">
        <h2>
          <a href={w.setup ? `#/a/${w.id}` : `#/w/${w.id}`}>{w.name}</a>
        </h2>
        <span className={`tag${w.live ? " ok" : ""}`}>{w.live ? "On" : "Off"}</span>
        {state && <span className={`state ${state.key}`}>{state.label}</span>}
      </div>
      <p className="muted">
        {lastEvent(w.last ?? null)}
        {state?.note ? `. ${state.note}` : ""}
      </p>
      <div className="actions">
        {w.live && w.formId && (
          <>
            <button type="button" onClick={() => onCopy(w.id, w.formId!)}>Copy form link</button>
            <FormEmbed link={`${location.origin}/forms/${w.formId}`} />
          </>
        )}
        <a href={`#/w/${w.id}/runs`}>Activity</a>
      </div>
    </li>
  );
}
