import { useLanguage } from "./Language";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Run } from "./api";
import type { Delivery } from "./Connections";
import { PageHead, StatePill } from "./Runs";
import { startedAt } from "./lib/activity";
import { filterRequests, recentRequests, type AskRequestItem, type AskRunInput } from "./lib/ask";
import { plainState } from "./lib/states";

type Answer = { headline: string; lines: string[]; fix: { href: string; label: string } | null };
type Reply = { runId: string; reference: string; workflowName: string; answers: { happened: Answer; why: Answer | null; next: Answer } };
type Which = "happened" | "why" | "next";

const QUESTIONS: { key: Which; label: string }[] = [
  { key: "happened", label: "What happened?" },
  { key: "why", label: "Why did it stop?" },
  { key: "next", label: "What do I do now?" },
];

/**
 * AI_ASK (decision 0041), O3 Doop frame jdE6cTyvay: a Questions card beside the Recorded answer. With `reference` (from a
 * run) nothing is typed; without it you type or pick one. Links only; the optional reword costs one AI action and changes no run.
 */
type AskedRun = Run & { deliveryFailed: boolean };

export function AskRequest({ reference, run }: { reference?: string; run?: AskedRun } = {}) {
  const { t, language: workspaceLanguage } = useLanguage();
  const [recent, setRecent] = useState<AskRequestItem[] | null>(null);
  const [text, setText] = useState("");
  const [reply, setReply] = useState<Reply | null>(null);
  const [which, setWhich] = useState<Which>("happened");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [language, setLanguage] = useState<"en" | "tl">(workspaceLanguage);
  const [wording, setWording] = useState<{ busy: boolean; text: string; error: string }>({ busy: false, text: "", error: "" });

  useEffect(() => {
    if (reference) return void load(reference);
    api<AskRunInput[]>("GET", "/runs?limit=50").then(
      (list) => setRecent(recentRequests(list)),
      () => setRecent([]),
    );
  }, [reference]);

  async function load(reference: string) {
    const ref = reference.trim();
    if (!ref) return;
    setText(ref);
    setBusy(true);
    setError("");
    setReply(null);
    setWording({ busy: false, text: "", error: "" });
    try {
      const r = await api<Reply>("GET", `/runs/ask?reference=${encodeURIComponent(ref)}`);
      setReply(r);
      setWhich("happened");
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? t("No request with that reference in this office.") : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void load(text);
  }

  function choose(w: Which) {
    setWhich(w);
    setWording({ busy: false, text: "", error: "" });
  }

  async function reword() {
    if (!reply) return;
    setWording({ busy: true, text: "", error: "" });
    try {
      const r = await api<{ text: string }>("POST", "/runs/ask/reword", { reference: reply.reference, question: which, language });
      setWording({ busy: false, text: r.text, error: "" });
    } catch (err) {
      setWording({ busy: false, text: "", error: (err as Error).message });
    }
  }

  const shown = reply ? (reply.answers[which] ?? reply.answers.happened) : null;
  const matching = recent ? filterRequests(recent, text) : [];
  return (
    <div className="act-ask">
      <section className="act-card" aria-labelledby="ask-questions-h">
        <h2 id="ask-questions-h">{t("Questions")}</h2>
        {!reference && (
          <form className="act-ask-find" onSubmit={submit}>
            <label htmlFor="ask-reference">{t("Request reference")}</label>
            <p className="act-muted">{t("Looks up recorded request references from your workspace activity. Enter a reference or pick one below.")}</p>
            <div className="act-filters">
              <input id="ask-reference" value={text} maxLength={40} placeholder={t("e.g. REQ-2026-0001")} onChange={(e) => setText(e.target.value)} />
              <button className="act-button blue" disabled={busy || !text.trim()}>{t("Ask")}</button>
            </div>
            {recent !== null && (
              recent.length === 0 ? (
                <p className="act-muted">
                  {t("No recorded requests with references yet. Requests appear here after a form or request automation runs.")}{" "}
                  <a href="#/activity">{t("Workspace activity")}</a>
                </p>
              ) : matching.length === 0 ? (
                <p className="act-muted">{t("No recent request matches that text. You can still submit the exact reference above.")}</p>
              ) : (
                <>
                  <p className="act-muted">{t("Recent requests:")}</p>
                  <ul className="act-picks" aria-label={t("Recent requests")}>
                    {matching.slice(0, 10).map((r) => {
                      const stateInfo = r.state ? plainState({ state: r.state, createdAt: r.createdAt || new Date().toISOString(), needsReview: r.state === "needs_review" }) : null;
                      return (
                        <li key={r.id}>
                          <button type="button" className="act-pick-btn" onClick={() => void load(r.reference)}>
                            <span className="act-mono">{r.reference}</span>
                            <span>{r.workflowName}</span>
                            {stateInfo && <span className={`act-pill ${stateInfo.key}`}>{t(stateInfo.label)}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )
            )}
          </form>
        )}
        {reply && (
          <div className="act-questions" role="group" aria-label={t("Question")}>
            {QUESTIONS.filter((q) => q.key !== "why" || reply.answers.why).map((q) => (
              <button key={q.key} type="button" aria-pressed={which === q.key} onClick={() => choose(q.key)}>
                {t(q.label)}
              </button>
            ))}
          </div>
        )}
        <p role="status" className="act-muted">{busy ? t("Looking up the request...") : ""}</p>
        <p role="alert" className="act-alert error" hidden={!error}>{error}</p>
      </section>

      <section className="act-card" aria-labelledby="ask-answer-h">
        <h2 id="ask-answer-h">{t("Recorded answer")}</h2>
        {!reply || !shown ? (
          <p className="act-muted">{t(reference ? "Loading…" : "Type or pick a request to read what happened.")}</p>
        ) : (
          <>
            {run && <p><StatePill run={run} /></p>}
            <p className="act-headline">{shown.headline}</p>
            {shown.lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
            {run && (
              <p className="act-source">
                {t("Started")} · {startedAt(run.createdAt, Date.now(), workspaceLanguage)}
              </p>
            )}
            {shown.fix && <p><a href={shown.fix.href}>{shown.fix.label}</a></p>}
            <details className="act-reword">
              <summary>{t("Simpler wording")}</summary>
              <div className="act-filters">
                <button type="button" className="act-button" disabled={wording.busy} onClick={() => void reword()}>
                  {t("Say it in simpler words (uses 1 AI action)")}
                </button>
                <select aria-label={t("Language")} value={language} onChange={(e) => setLanguage(e.target.value as "en" | "tl")}>
                  <option value="en">English</option>
                  <option value="tl">Tagalog</option>
                </select>
              </div>
              <p role="status" className="act-muted">{wording.busy ? t("Asking the AI model...") : ""}</p>
              {wording.text && (
                <>
                  <h3>{t("Written by the AI model")}</h3>
                  <p>{wording.text}</p>
                </>
              )}
              <p role="alert" className="act-alert error" hidden={!wording.error}>{wording.error}</p>
            </details>
            <p className="act-ask-foot">
              <a href={`#/runs/${reply.runId}`}>{t("Open run detail")}</a>
            </p>
            <p className="act-muted">{t("Answers come from kymavo's own rules. Nothing here changes the request.")}</p>
          </>
        )}
      </section>
    </div>
  );
}

const askHead = (t: ReturnType<typeof useLanguage>["t"], last: string, sub?: string) => (
  <PageHead
    crumbs={[{ label: t("Activity"), href: "#/activity" }, { label: last }]}
    title={t("Ask about a request")}
    sub={sub}
    actions={<a className="act-button" href="#/activity">{t("Workspace activity")}</a>}
  />
);

/** #/activity/ask (O3 without a run): type or pick a request reference, then read the answers. */
export function AskPage() {
  const { t } = useLanguage();
  return (
    <main className="page act">
      {askHead(t, t("Ask"))}
      <div className="act-body motion-page">
        <AskRequest />
      </div>
    </main>
  );
}

/** #/runs/<id>/ask (O3): the answers for this run's request. The run and its deliveries are read once for the state pill and start time. */
export function AskRunPage({ runId }: { runId: string }) {
  const { t } = useLanguage();
  const [run, setRun] = useState<AskedRun | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([api<Run>("GET", `/runs/${runId}`), api<Delivery[]>("GET", `/deliveries?runId=${runId}`).catch(() => [])]).then(
      ([r, deliveries]) => setRun({ ...r, deliveryFailed: deliveries.some((d) => d.state === "failed") }),
      (e: Error) => setError(e.message),
    );
  }, [runId]);
  return (
    <main className="page act">
      {askHead(t, run?.reference ?? "…", run ? [run.workflowName, run.reference].filter(Boolean).join(" · ") : undefined)}
      <div className="act-body motion-page">
        <p role="alert" className="act-alert error" hidden={!error}>{error}</p>
        {!run ? (
          !error && <p className="act-muted" role="status">{t("Loading…")}</p>
        ) : run.reference ? (
          <AskRequest reference={run.reference} run={run} />
        ) : (
          <p>
            {t("This run was not started by a request, so there is nothing to ask about.")} <a href={`#/runs/${run.id}`}>{t("Open run detail")}</a>
          </p>
        )}
      </div>
    </main>
  );
}
