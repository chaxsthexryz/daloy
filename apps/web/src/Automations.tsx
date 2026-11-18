import { Text, useLanguage } from "./Language";
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
  const { t } = useLanguage();
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
      () => setCopied(t("Form link copied for {name}.", { name: list?.find((w) => w.id === id)?.name ?? t("this automation") })),
      () => setCopied(t("Copy this link: {link}", { link })),
    );
  };

  const remove = async (w: Workflow) => {
    if (!window.confirm(t("Delete the draft {name}? This cannot be undone.", { name: `"${w.name}"` }))) return;
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
      <Header title={t("Automations")} action={owner && <a className="primary" href="#/new"><Text>New automation</Text></a>} />
      {review.length > 0 && (
        <p role="status" className="needs-you">
          <strong>{review.length >= 50 ? t("50 or more") : review.length}</strong> {t(review.length === 1 ? "request needs you." : "requests need you.")}{" "}
          <a href={`#/runs/${review[review.length - 1]!.id}`}><Text>Open the oldest</Text></a>
        </p>
      )}
      <p role="status" className="muted" hidden={!copied}>
        {copied}
      </p>
      {listError && (
        <p role="alert" className="message error">
          {t("Couldn't load your automations.")} <button type="button" onClick={load}><Text>Retry</Text></button>
        </p>
      )}
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {list === null ? (
        listError ? null : <p><Text>Loading…</Text></p>
      ) : list.length === 0 ? (
        <p className="muted">{owner ? <>{t("No automations yet.")} <a href="#/new"><Text>Add your first one</Text></a>.</> : t("No automations yet.")}</p>
      ) : (
        <>
          <div className="filters">
            <div className="field">
              <label htmlFor="find"><Text>Find an automation</Text></label>
              <input id="find" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="actions" role="group" aria-label={t("Show")}>
              {FILTERS.map(([key, label]) => (
                <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {t(label)}
                </button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <p className="muted"><Text>None match.</Text></p>
          ) : (
            <ul className="cards">
              {shown.map((w) => (
                <Card key={w.id} w={w} onCopy={copy} />
              ))}
            </ul>
          )}
          {drafts.length > 0 && (
            <details className="drafts">
              <summary>{t("Drafts ({count})", { count: drafts.length })}</summary>
              <ul className="list">
                {drafts.map((w) => (
                  <li key={w.id}>
                    <a href={`#/a/${w.id}`}>{t("{name}: continue setup", { name: w.name })}</a> <span className="muted">{t("started {date}", { date: new Date(w.createdAt).toLocaleDateString() })}</span>{" "}
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
  const { t, language } = useLanguage();
  const state = w.last ? plainState(w.last) : null;
  return (
    <li className="card">
      <div className="card-head">
        <h2>
          <a href={w.setup ? `#/a/${w.id}` : `#/w/${w.id}`}>{w.name}</a>
        </h2>
        <span className={`tag${w.live ? " ok" : ""}`}>{t(w.live ? "On" : "Off")}</span>
        {state && <span className={`state ${state.key}`}>{t(state.label)}</span>}
        {w.scheduleMissedAt && <span className="state problem">{t("Missed its schedule")}</span>}
      </div>
      <p className="muted">
        {lastEvent(w.last ?? null, Date.now(), language)}
        {state?.note ? `. ${t(state.note)}` : ""}
      </p>
      <div className="actions">
        {w.live && w.formId && (
          <>
            <button type="button" onClick={() => onCopy(w.id, w.formId!)}><Text>Copy form link</Text></button>
            <FormEmbed link={`${location.origin}/forms/${w.formId}`} />
          </>
        )}
        <a href={`#/w/${w.id}/runs`}><Text>Activity</Text></a>
      </div>
    </li>
  );
}
