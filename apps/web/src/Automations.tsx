import { useEffect, useState } from "react";
import { api, type RunSummary, type Workflow } from "./api";
import { Header } from "./Nav";
import { isDraft } from "./lib/drafts";
import { lastEvent, plainState } from "./lib/states";
import { startOfficeSetup, startPurchaseSetup } from "./OfficeRequests";
import type { User } from "./Team";

/** Home: one card per automation with its state, last event and the few things an owner does with it. */
export function Automations({ user }: { user: User }) {
  const owner = user.role === "owner";
  const [list, setList] = useState<Workflow[] | null>(null);
  const [listError, setListError] = useState(false);
  const [review, setReview] = useState<RunSummary[]>([]);
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
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

  return (
    <main className="page">
      <Header title="Automations" />
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
      {list === null ? (
        listError ? null : <p>Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">{owner ? "No automations yet. Add one below." : "No automations yet."}</p>
      ) : (
        <ul className="cards">
          {list.map((w) => (
            <Card key={w.id} w={w} onCopy={copy} />
          ))}
        </ul>
      )}
      {owner && (
        <section className="create" aria-labelledby="automate">
          <h2 id="automate">Add an automation</h2>
          <h3>Track an office request</h3>
          <p>Staff fill in a form. Each request gets a reference. Your office receives a notification.</p>
          <div className="actions">
            <a href="#/try/office-request">Try an example</a>
            <button type="button" className="primary" onClick={() => startOfficeSetup(user.email).catch((e: Error) => setError(e.message))}>
              Set up for my office
            </button>
          </div>
          <h3>Purchase request with a named approver</h3>
          <p>Staff ask to buy something and get a reference. The person you name approves or rejects it in Daloy. Approved requests go to purchasing, from Outlook and with a Teams note if you connect them.</p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => startPurchaseSetup(user.email).catch((e: Error) => setError(e.message))}>
              Set up purchase requests
            </button>
          </div>
          <h3>Reply to a website inquiry</h3>
          <p>Visitors fill in your inquiry form. They get a reply from your own email address, and your inbox gets the inquiry.</p>
          <div className="actions">
            <a href="#/settings/business">Set up inquiry replies</a>
          </div>
          <p role="alert" className="message error" hidden={!error}>
            {error}
          </p>
        </section>
      )}
    </main>
  );
}

function Card({ w, onCopy }: { w: Workflow; onCopy: (id: string, formId: string) => void }) {
  const draft = isDraft(w);
  const state = w.last ? plainState(w.last) : null;
  return (
    <li className="card">
      <div className="card-head">
        <h2>
          <a href={w.setup ? `#/a/${w.id}` : `#/w/${w.id}`}>{w.name}</a>
        </h2>
        {draft ? <span className="tag">Draft</span> : <span className={`tag${w.live ? " ok" : ""}`}>{w.live ? "On" : "Off"}</span>}
        {state && <span className={`state ${state.key}`}>{state.label}</span>}
      </div>
      {draft ? (
        <p>
          <a className="tag" href={`#/a/${w.id}`}>Draft: continue setup</a>
        </p>
      ) : (
        <p className="muted">
          {lastEvent(w.last ?? null)}
          {state?.note ? `. ${state.note}` : ""}
        </p>
      )}
      <div className="actions">
        {w.live && w.formId && (
          <button type="button" onClick={() => onCopy(w.id, w.formId!)}>
            Copy form link
          </button>
        )}
        <a href={`#/w/${w.id}/runs`}>Activity</a>
        <button type="button" disabled title="Pausing an automation is coming">
          Pause (coming)
        </button>
      </div>
    </li>
  );
}
