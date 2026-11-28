import { useLanguage } from "./Language";
import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Run, type RunSummary, type StepRun, type Version, type Workflow } from "./api";
import { DeliveryList, type Delivery } from "./Connections";
import { AutomationTabs } from "./Nav";
import { AskRequest } from "./AskRequest";
import { Breadcrumb } from "./Breadcrumb";
import { stepLabel } from "@daloy/engine";
import { RunFlow } from "./FlowCanvas";
import { handledFailure, runFlow, STATUS } from "./lib/run-flow";
import "./operations.css";
import "./activity.css";
import { clock, longDate, startedAt } from "./lib/activity";
import type { Draft } from "./lib/graph";
import { pollDelay, takingLonger } from "./lib/poll";
import { fileRefs, fileSize } from "./lib/run-files";
import { fixFor, ownerError, plainState, runKind, sentAlone } from "./lib/states";

/**
 * Polls a run until it finishes, so the page shows each step as the worker records it: every second while work moves,
 * every 10 s while a person must act (pollDelay). A failed fetch sets `error` and keeps polling until one succeeds.
 * A new `reload` value polls again.
 */
export function useRun(runId: string | null, reload = 0) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    setRun(null);
    setError(false);
    if (!runId) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      const r = await api<Run>("GET", `/runs/${runId}`).catch(() => null);
      if (stopped) return;
      setError(!r);
      if (r) setRun(r);
      const delay = r ? pollDelay(r.state) : 1000;
      if (delay !== null) timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId, reload]);
  return { run, error };
}

/** Time between two timestamps ("850 ms", "1.2 s", "3 min"), or "not finished" while the second one is missing. */
export function duration(from: string, to: string | null): string {
  if (!to) return "not finished";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}

export const TAKING_LONGER = "Taking longer than usual. Tell the person who runs kymavo.";
const SUPERSEDED = "Superseded: its booking was rescheduled or cancelled. It stops at its next step and sends nothing more.";

const kind = (r: { test: boolean; live: boolean; aiLive?: boolean; testChoices?: Record<string, object> | null }) =>
  r.test ? (r.live ? "test run, live calls" : r.aiLive ? "test run, real AI, other calls mocked" : sentAlone(r) ? "test run, one step live, other calls mocked" : "test run, mocked calls") : "live run";
const json = (v: unknown) => JSON.stringify(v, null, 2);

// A named approval's step output holds who answered and when (decision 0022).
function decided(output: unknown, t: ReturnType<typeof useLanguage>["t"]): string | null {
  const o = output as { decidedBy?: unknown; decidedAt?: unknown } | null;
  return typeof o?.decidedBy === "string" && typeof o.decidedAt === "string" ? t("Decided by {name} at {time}", { name: o.decidedBy, time: new Date(o.decidedAt).toLocaleString() }) : null;
}

// A delay whose time had passed and that has no late edge ends the run (decision 0031).
const skipped = (output: unknown, t: ReturnType<typeof useLanguage>["t"]) => {
  const s = (output as { skipped?: unknown } | null)?.skipped;
  return typeof s === "string" ? t("Skipped: {reason}", { reason: s }) : null;
};

/** One step attempt: state, branch, duration, error and the details a technician needs. The run result and the editor's "Last test" share it. */
export function StepAttempt({ s }: { s: StepRun }) {
  const { t } = useLanguage();
  return (
    <>
      <span className={`badge ${s.state}`}>{s.state}</span> {s.stepId}
      {s.attempt > 1 && <span className="muted"> {t("attempt {count}", { count: s.attempt })}</span>}
      {s.branch && <span className="muted"> → {s.branch}</span>}
      <span className="muted"> · {t(duration(s.createdAt, s.finishedAt))}</span>
      {s.inputTokens !== null && <span className="muted"> · {t("{input} in, {output} out tokens", { input: s.inputTokens, output: s.outputTokens ?? 0 })}</span>}
      {s.error && <p className="message error">{s.error}</p>}
      {decided(s.output, t) && <p className="muted">{decided(s.output, t)}</p>}
      {skipped(s.output, t) && <p className="muted">{skipped(s.output, t)}</p>}
      {handledFailure(s) && <p className="muted">{t(handledFailure(s)!)}</p>}
      {s.outcome && <p className="muted">{t("Outcome: {outcome}", { outcome: s.outcome.replace("_", " ") })}</p>}
      {s.resolvedBy && s.resolvedAt && (
        <p className="muted">
          {t("Answered by {name} at {time}", { name: s.resolvedBy, time: new Date(s.resolvedAt).toLocaleString() })}
        </p>
      )}
      {s.input !== null && (
        <details>
          <summary>{t("Input")}</summary>
          <pre aria-label={t("Input of {step}", { step: s.stepId })}>{json(s.input)}</pre>
        </details>
      )}
      {s.output !== null && <pre aria-label={t("Output of {step}", { step: s.stepId })}>{json(s.output)}</pre>}
    </>
  );
}

/** One run's steps: state, branch, attempt, timing, and the input and output the worker stored (secrets masked by the API). */
export function RunResult({ run }: { run: Run }) {
  const { t } = useLanguage();
  return (
    <div className="run" aria-live="polite">
      <p>
        <span className={`badge ${run.state}`}>{run.state}</span> {t(kind(run))}
      </p>
      {run.superseded && <p className="message">{t(SUPERSEDED)}</p>}
      {run.error && <p className="message error">{run.error}</p>}
      <ol className="steps">
        {run.steps.map((s) => (
          <li key={s.id}>
            <StepAttempt s={s} />
          </li>
        ))}
      </ol>
    </div>
  );
}

const FILTERS = { all: "", live: "&test=false", test: "&test=true", review: "&review=true", problem: "&state=problem", waiting: "&state=waiting" } as const;

/** A run's owner-facing state as a coloured pill (Done, Waiting, Needs you, Problem, Working). */
export function StatePill({ run, note }: { run: { state: string; createdAt: string; needsReview: boolean; superseded?: boolean; deliveryFailed?: boolean }; note?: boolean }) {
  const { t } = useLanguage();
  const s = plainState(run);
  return (
    <>
      <span className={`act-pill ${s.key}`} title={s.note ? t(s.note) : undefined}>{t(s.label)}</span>
      {note && s.note && <span className="act-muted"> {t(s.note)}</span>}
    </>
  );
}

/** The white title strip of the Activity, run, Ask, Bookings and Versions pages: breadcrumb, title, subtitle, actions, tabs. */
export function PageHead({ crumbs, title, sub, actions, tabs }: { crumbs: { label: string; href?: string }[]; title: string; sub?: ReactNode; actions?: ReactNode; tabs?: ReactNode }) {
  return (
    <header className={tabs ? "act-head tabbed" : "act-head"}>
      {crumbs.length > 0 && (
        <div className="act-crumbs">
          <Breadcrumb items={crumbs} />
        </div>
      )}
      <div>
        <h1>{title}</h1>
        {sub && <p className="act-sub">{sub}</p>}
      </div>
      {actions && <div className="act-actions">{actions}</div>}
      {tabs}
    </header>
  );
}

/** One automation's head (A8, A9): the name and the automation's tabs; the sidebar shows where it sits (decision 0164). */
export function WorkflowHead({ workflowId, wf, here, actions }: { workflowId: string; wf: (Workflow & { live: unknown }) | null; here: "activity" | "versions"; actions?: ReactNode }) {
  const { t } = useLanguage();
  const name = wf?.name ?? t("Automation");
  return (
    <PageHead
      crumbs={[]}
      title={name}
      actions={actions}
      tabs={
        // Nav.tsx owns AutomationTabs (Overview, Activity, Steps); Versions sits beside it until that tab is added there.
        // On Versions no AutomationTabs entry is current, so `here` names none of its keys.
        <div className="act-tabs">
          <AutomationTabs id={workflowId} here={here as "activity"} overview={!!wf?.setup && !!wf.live} />
          <nav className="tabs" aria-label={t("History")}>
            <a href={`#/w/${workflowId}/versions`} aria-current={here === "versions" ? "page" : undefined}>{t("Versions")}</a>
          </nav>
        </div>
      }
    />
  );
}

/** #/activity (O1): the latest 50 runs of every automation, or #/w/<id>/runs (A8): of one, beside its run details. */
export function RunsPage({ workflowId, ask }: { workflowId?: string; ask?: boolean }) {
  const { t, language } = useLanguage();
  const [wf, setWf] = useState<(Workflow & { live: unknown }) | null>(null);
  const [filter, setFilter] = useState<keyof typeof FILTERS>("all");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  useEffect(() => {
    if (workflowId) api<Workflow & { live: unknown }>("GET", `/workflows/${workflowId}`).then(setWf, (e: Error) => setError(e.message));
  }, [workflowId]);
  useEffect(() => {
    let current = true;
    const scope = workflowId ? `workflowId=${workflowId}` : `q=${encodeURIComponent(query.trim())}`;
    api<RunSummary[]>("GET", `/runs?${scope}${FILTERS[filter]}`).then(
      // Only the newest answer counts, so a slow search for "RE" never replaces the one for "REQ-7".
      (l) => current && setList(l),
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [workflowId, filter, query]);

  const select = (
    <select aria-label={t("Status")} value={filter} onChange={(e) => setFilter(e.target.value as keyof typeof FILTERS)}>
      <option value="all">{t("All statuses")}</option>
      <option value="live">{t("Real runs")}</option>
      <option value="test">{t("Previews")}</option>
      <option value="review">{t("Needs you")}</option>
      <option value="problem">{t("Problem")}</option>
      <option value="waiting">{t("Waiting")}</option>
    </select>
  );
  const caption = list && list.length > 0 && (
    <caption className="act-sr">{list.length === 1 ? t("1 item") : t("Latest {count} items, newest first", { count: list.length })}</caption>
  );
  const empty = list === null ? <p className="act-empty" role="status">{t("Loading…")}</p> : list.length === 0 ? <p className="act-empty">{t(query.trim() ? "Nothing matches." : "Nothing has happened yet.")}</p> : null;
  const alert = <p role="alert" className="act-alert error" hidden={!error}>{error}</p>;

  if (!workflowId) {
    return (
      <main className="page act">
        <PageHead
          crumbs={[]}
          title={t("Workspace activity")}
          sub={longDate(Date.now(), language)}
        />
        <div className="act-body motion-page">
          <section className="act-card" aria-labelledby="runs-h">
            <h2 id="runs-h">{t("Recent runs")}</h2>
            <div className="act-filters">
              <input type="search" aria-label={t("Find a request or automation")} placeholder={t("Search reference or automation")} value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} />
              {select}
              {ask && (
                <button type="button" className="act-button" aria-expanded={askOpen} onClick={() => setAskOpen((was) => !was)}>
                  {askOpen ? t("Hide question helper") : t("Ask about a request")}
                </button>
              )}
            </div>
            {ask && askOpen && <AskRequest />}
            {alert}
            {empty ?? (
              <table className="act-table">
                {caption}
                <thead>
                  <tr>
                    <th scope="col">{t("Reference")}</th>
                    <th scope="col">{t("Automation")}</th>
                    <th scope="col">{t("Started")}</th>
                    <th scope="col">{t("Took")}</th>
                    <th scope="col">{t("Status")}</th>
                    {ask && <th scope="col"><span className="act-sr">{t("Ask")}</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {list!.map((r) => (
                    <tr key={r.id}>
                      <td className="ref"><a href={`#/runs/${r.id}`}>{r.reference ?? t(runKind(r))}</a></td>
                      <td className="strong" data-label={t("Automation")}>{r.workflowName}</td>
                      <td data-label={t("Started")}><time dateTime={r.createdAt}>{startedAt(r.createdAt, Date.now(), language)}</time></td>
                      <td data-label={t("Took")}>{t(duration(r.createdAt, r.finishedAt))}</td>
                      <td className="bare"><StatePill run={r} /></td>
                      {ask && <td className="bare">{r.reference && <a href={`#/runs/${r.id}/ask`}>{t("Ask what happened")}</a>}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </main>
    );
  }

  const chosen = list?.find((r) => r.id === picked) ?? list?.[0] ?? null;
  return (
    <main className="page act">
      <WorkflowHead workflowId={workflowId} wf={wf} here="activity" actions={<a className="act-button" href={`/runs/export.csv?workflowId=${workflowId}`} download>{t("Download CSV")}</a>} />
      <div className="act-split">
        <section className="act-list motion-page" aria-labelledby="runs-h">
          <div className="act-list-head">
            <div>
              <h2 id="runs-h">{t("Activity")}</h2>
              <p>{t("Recent submissions, test runs and delivery outcomes for {name}.", { name: wf?.name ?? t("this automation") })}</p>
            </div>
            <div className="act-filters">{select}</div>
          </div>
          {alert}
          {empty ?? (
            <table className="act-table">
              {caption}
              <thead>
                <tr>
                  <th scope="col">{t("Request")}</th>
                  <th scope="col">{t("Started")}</th>
                  <th scope="col">{t("Source")}</th>
                  <th scope="col">{t("Outcome")}</th>
                </tr>
              </thead>
              <tbody>
                {list!.map((r) => (
                  // Pointer or keyboard focus on a row shows its steps in the panel; the link opens the full run.
                  <tr key={r.id} data-selected={r.id === chosen?.id || undefined} onClick={() => setPicked(r.id)} onFocus={() => setPicked(r.id)}>
                    <td className="ref">
                      <a href={`#/runs/${r.id}`}>{r.reference ?? t(runKind(r))}</a>
                      <span className="sub">{t(duration(r.createdAt, r.finishedAt))}</span>
                    </td>
                    <td data-label={t("Started")}><time dateTime={r.createdAt}>{startedAt(r.createdAt, Date.now(), language)}</time></td>
                    <td data-label={t("Source")}>{t(runKind(r))}</td>
                    <td className="bare">
                      <StatePill run={r} />
                      {ask && r.reference && <> <a href={`#/runs/${r.id}/ask`}>{t("Ask what happened")}</a></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <RunPanel runId={chosen?.id ?? null} overview={wf?.setup && wf.live ? `#/a/${workflowId}` : null} />
      </div>
    </main>
  );
}

/** A8's right-hand panel: the selected run's steps, numbered, with links to the full run. Hidden on a phone. */
function RunPanel({ runId, overview }: { runId: string | null; overview: string | null }) {
  const { t, language } = useLanguage();
  const { run, error } = useRun(runId);
  if (!runId) return <aside className="act-panel" aria-label={t("Run details")} />;
  return (
    <aside className="act-panel motion-drawer" key={runId} aria-label={t("Run details")}>
      <p className="act-eyebrow">{t("Run details")}</p>
      {!run ? (
        <p className="act-muted" role="status">{t(error ? "Couldn't load this run. Trying again." : "Loading…")}</p>
      ) : (
        <>
          <h2>{run.reference ?? t(runKind(run))}</h2>
          <p className="act-muted">{startedAt(run.createdAt, Date.now(), language)} · {t(runKind(run))}</p>
          {run.steps.length === 0 ? (
            <p className="act-muted">{t("No steps have run yet.")}</p>
          ) : (
            <ol className="act-steps">
              {run.steps.map((s, i) => (
                <li key={s.id}>
                  <span className="act-num" aria-hidden="true">{i + 1}</span>
                  <span className="title">{s.stepId}</span>
                  <span className="note">{t(STEP_STATE[s.state] ?? s.state)} · {t(duration(s.createdAt, s.finishedAt))}</span>
                </li>
              ))}
            </ol>
          )}
          <p><a href={`#/runs/${run.id}`}>{t("Open run detail")}</a></p>
          {overview && <p><a href={overview}>{t("Back to overview")}</a></p>}
        </>
      )}
    </aside>
  );
}

// A step attempt's raw state in the owner's words. Unknown states show as they are.
const STEP_STATE: Record<string, string> = { succeeded: "Done", failed: "Failed", running: "Working", pending: "Working", waiting: "Waiting", needs_review: "Needs you", cancelled: "Cancelled", skipped: "Skipped" };

/** #/runs/<id> (O2, Doop frame aquI2X-gdg): the run's step timeline beside its outcome and recovery controls. Polls until the run finishes. */
export function RunPage({ runId, owner, ask, admin = false }: { runId: string; owner: boolean; ask?: boolean; admin?: boolean }) {
  const { t } = useLanguage();
  const [reload, setReload] = useState(0);
  const [deliveryFailed, setDeliveryFailed] = useState(false);
  const { run, error } = useRun(runId, reload);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftFailed, setDraftFailed] = useState(false);
  useEffect(() => {
    setDraft(null);
    setDraftFailed(false);
    if (!run) return;
    api<Version>("GET", `/workflows/${run.workflowId}/versions/${run.version}`).then(
      (v) => setDraft(v.definition as Draft),
      () => setDraftFailed(true),
    );
  }, [run?.workflowId, run?.version]);
  if (!run) {
    return (
      <main className="page act">
        <PageHead crumbs={[{ label: t("Activity"), href: "#/activity" }]} title={t("Activity")} />
        <div className="act-body">
          {error ? (
            <p role="alert" className="act-alert error">
              {t("Couldn't load this run. Trying again.")}{" "}
              <button type="button" className="act-button" onClick={() => setReload((n) => n + 1)}>{t("Retry")}</button>
            </p>
          ) : (
            <p className="act-muted" role="status">{t("Loading…")}</p>
          )}
        </div>
      </main>
    );
  }
  const working = run.state === "pending" || run.state === "running" || run.state === "queued";
  const activity = `#/w/${run.workflowId}/runs`;
  // Opens the editor with this run's trigger data as the sample; the test still fakes every app (T2).
  const retest = `#/w/${run.workflowId}?from=${run.id}`;
  return (
    <main className="page act run-detail">
      <PageHead
        crumbs={[{ label: t("Activity"), href: "#/activity" }, { label: run.reference ?? t(runKind(run)) }]}
        title={run.workflowName}
        sub={[run.reference && t("Run {reference}", { reference: run.reference }), t(runKind(run))].filter(Boolean).join(" · ")}
        actions={
          <>
            {run.state === "failed" && <a className="act-button" href={retest}>{t("Test with this data")}</a>}
            <a className="act-button" href={activity}>{t("Activity")}</a>
            {ask && run.reference && <a className="act-button blue" href={`#/runs/${run.id}/ask`}>{t("Ask what happened")}</a>}
            {run.state !== "failed" && <a className="act-button" href={retest}>{t("Test with this data")}</a>}
          </>
        }
      />
      <div className="act-body act-run motion-page">
        {error && <p role="alert" className="act-alert error">{t("Couldn't refresh. Trying again.")}</p>}
        {working && takingLonger(run.createdAt) && <p className="act-alert">{t(TAKING_LONGER)}</p>}
        <section className="act-card" aria-labelledby="timeline-h">
          <h2 id="timeline-h">{t("Run timeline")}</h2>
          <RunTimeline run={run} draft={draft} />
          <details className="act-fields">
            <summary>{t("Masked request fields")}</summary>
            <pre aria-label={t("Request fields")}>{json(run.triggerPayload)}</pre>
          </details>
        </section>
        <section className="act-card" aria-labelledby="outcome-h">
          <h2 id="outcome-h">{t("Delivery outcome")}</h2>
          <p aria-live="polite">
            <StatePill run={{ ...run, deliveryFailed }} note />
          </p>
          {run.superseded && <p className="act-alert">{t(SUPERSEDED)}</p>}
          <RunWhy run={run} owner={owner} admin={admin} />
          <RunDeliveries runId={runId} onLoad={(l) => setDeliveryFailed(l.some((d) => d.state === "failed"))} />
          <dl className="act-facts">
            <div>
              <dt>{t("Started")}</dt>
              <dd>{new Date(run.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t("Elapsed time")}</dt>
              <dd>{t(duration(run.createdAt, run.finishedAt))}</dd>
            </div>
          </dl>
          <RunActions run={run} onDone={() => setReload((n) => n + 1)} />
        </section>
        <RunFiles runId={runId} payload={run.triggerPayload} />
        <RunPath run={run} draft={draft} failed={draftFailed} />
        <details className="act-card technician">
          <summary>{t("Details for a technician")}</summary>
          <p className="act-muted">
            {t("Raw state: {state} · version v{version} · {kind}", { state: run.state, version: run.version, kind: t(kind(run)) })}
          </p>
          {run.error && <pre aria-label={t("Full error")}>{run.error}</pre>}
          <h3>{t("Trigger data")}</h3>
          <pre aria-label={t("Trigger data")}>{json(run.triggerPayload)}</pre>
          <h3>{t("Steps")}</h3>
          <RunResult run={run} />
        </details>
      </div>
    </main>
  );
}

/** O2's numbered step list: each attempt's step, what happened to it, and when it started (hh:mm:ss). */
function RunTimeline({ run, draft }: { run: Run; draft: Draft | null }) {
  const { t, language } = useLanguage();
  if (run.steps.length === 0) return <p className="act-muted">{t("No steps have run yet.")}</p>;
  return (
    <ol className="act-timeline">
      {run.steps.map((s, i) => {
        const defStep = draft?.steps.find((x) => x.id === s.stepId);
        const title = defStep ? `${stepLabel(defStep.type, language)} (${s.stepId})` : s.stepId;
        const notes = [
          s.attempt > 1 ? t("attempt {count}", { count: s.attempt }) : "",
          s.branch ? `→ ${s.branch}` : "",
          decided(s.output, t) ?? "",
          skipped(s.output, t) ?? "",
          handledFailure(s) ? t(handledFailure(s)!) : "",
          s.outcome ? t("Outcome: {outcome}", { outcome: s.outcome.replace("_", " ") }) : "",
          s.resolvedBy && s.resolvedAt ? t("Answered by {name} at {time}", { name: s.resolvedBy, time: new Date(s.resolvedAt).toLocaleString() }) : "",
        ].filter(Boolean);
        return (
          <li key={s.id}>
            <span className="act-num" aria-hidden="true">{i + 1}</span>
            <div>
              <p className="title">{title} <span className={`act-step ${s.state}`}>{t(STEP_STATE[s.state] ?? s.state)}</span></p>
              {notes.length > 0 && <p className="act-muted">{notes.join(" · ")}</p>}
              {s.error && <p className="act-alert error">{ownerError(s.error)}</p>}
            </div>
            <time dateTime={s.createdAt}>{clock(s.createdAt, true)}</time>
          </li>
        );
      })}
    </ol>
  );
}

/** Files attached to the request. Plain download links only: the server sends them as attachments, and they are never previewed in the page. */
function RunFiles({ runId, payload }: { runId: string; payload: unknown }) {
  const { t } = useLanguage();
  const files = fileRefs(payload);
  if (files.length === 0) return null;
  return (
    <section className="act-card" aria-labelledby="run-files-h">
      <h2 id="run-files-h">{t("Files")}</h2>
      <ul>
        {files.map((f) => (
          <li key={f.id}>
            {f.name} <span className="muted">{fileSize(f.size)}</span>{" "}
            <a href={`/runs/${runId}/files/${f.id}`} download>
              {t("Download")}<span className="visually-hidden"> {f.name}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Explanation = { facts: unknown; fixed: { headline: string; lines: string[]; fix: { href: string; label: string } | null; aiExplain?: boolean } };

/** Why a stopped run stopped: the server's fixed explanation (fetched once per state change), else the plain error. Owners can ask the AI model to reword it. */
function RunWhy({ run, owner, admin }: { run: Run; owner: boolean; admin: boolean }) {
  const { language, t } = useLanguage();
  const key = plainState(run).key;
  const stopped = key === "problem" || key === "needs_you";
  const [fixed, setFixed] = useState<Explanation["fixed"] | null>(null);
  const [reply, setReply] = useState<{ text?: string; error?: string; modelFailed?: boolean } | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    setFixed(null);
    setReply(null);
    if (!stopped) return;
    let live = true;
    api<Explanation | null>("GET", `/runs/${run.id}/explanation`).then(
      (e) => live && setFixed(e?.fixed ?? null),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [run.id, stopped, key, language]);
  if (!fixed) return run.error ? <section aria-label={t("Why it stopped")}><RunError error={run.error} owner={owner} admin={admin} /></section> : null;
  const ask = () => {
    setAsking(true);
    api<{ text: string }>("POST", `/runs/${run.id}/explanation/reword`, {})
      .then((r) => setReply({ text: r.text }))
      .catch((e) => setReply(e instanceof ApiError && e.status === 429 ? { error: e.message } : { modelFailed: true }))
      .finally(() => setAsking(false));
  };
  const visibleFix = fixed.fix && fixed.fix.href === "#/settings/ai" && !admin ? { href: "#/settings", label: t("See plan and usage") } : fixed.fix;
  const fallbackReason =
    fixed.headline === "kymavo could not tell why this stopped." || fixed.headline === "Hindi matukoy ng kymavo kung bakit ito huminto.";
  return (
    <section aria-label={t("Why it stopped")}>
      <p className={key === "problem" ? "message error" : "message"}>{fixed.headline}</p>
      {fixed.lines.map((l, i) => (
        <p key={i}>{l}</p>
      ))}
      {fallbackReason && run.error && <RunError error={run.error} owner={owner} admin={admin} />}
      {owner && visibleFix && (
        <p>
          <a href={visibleFix.href}>{visibleFix.label}</a>
        </p>
      )}
      {owner && fixed.aiExplain !== false && (
        <button type="button" disabled={asking} onClick={ask}>
          {t(asking ? "Asking the AI model…" : "Explain in simpler words (uses 1 AI action)")}
        </button>
      )}
      {reply?.text !== undefined && (
        <>
          <p className="muted">{t("Written by the AI model. Check it against the details above.")}</p>
          <p>{reply.text}</p>
        </>
      )}
      {reply?.error && <p role="alert" className="message error">{reply.error}</p>}
      {reply?.modelFailed && (
        <p role="alert" className="message error">
          {t("The AI model could not answer.")}
          {admin && (
            <>
              {" "}
              <a href="#/settings/ai">{t("Check the AI model")}</a>
            </>
          )}
        </p>
      )}
    </section>
  );
}

/** The run's error in the owner's words, with a link to the page that fixes it when the error says which (owners only). */
function RunError({ error, owner, admin }: { error: string; owner: boolean; admin: boolean }) {
  const { t } = useLanguage();
  const fix = owner ? fixFor(error, admin) : null;
  return (
    <p className="message error">
      {ownerError(error)}
      {fix && (
        <>
          {" "}
          <a href={fix.href}>{t(fix.label)}</a>
        </>
      )}
    </p>
  );
}

/** The path this run took: the version's diagram, redrawn on every poll with the state of each step (read only). */
function RunPath({ run, draft, failed }: { run: Run; draft: Draft | null; failed: boolean }) {
  const { t, language } = useLanguage();
  if (failed) return <p className="muted">{t("The diagram could not load. The steps are listed under Details for a technician.")}</p>;
  if (!draft) return null;
  const states = runFlow(draft, run).nodes;
  return (
    <section className="act-card run-path" aria-label={t("Path it took")}>
      <h2>{t("Path it took")}</h2>
      <RunFlow draft={draft} run={run} />
      <ol className="operations-path-list">
        {draft.steps.map((step) => (
          <li key={step.id}>
            <span className={`state ${states[step.id] ?? "idle"}`}>{t(STATUS[states[step.id] ?? "idle"].label)}</span>
            <span>{stepLabel(step.type, language)} <span className="muted">({step.id})</span></span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Sheets rows and Slack notes this run queued. They are delivered apart from the run, so they have their own state. */
function RunDeliveries({ runId, onLoad }: { runId: string; onLoad?: (list: Delivery[]) => void }) {
  const { t } = useLanguage();
  const [list, setList] = useState<Delivery[]>([]);
  const [failed, setFailed] = useState(false);
  const load = () =>
    api<Delivery[]>("GET", `/deliveries?runId=${runId}`).then(
      (l) => {
        setFailed(false);
        setList(l);
        onLoad?.(l);
      },
      () => setFailed(true),
    );
  useEffect(() => void load(), [runId]);
  if (failed) return <p role="alert">{t("Couldn't load deliveries.")} <button type="button" onClick={() => void load()}>{t("Retry")}</button></p>;
  if (list.length === 0) return null;
  return (
    <>
      <h3>{t("Where it was sent")}</h3>
      <DeliveryList deliveries={list} onChange={load} />
    </>
  );
}

/**
 * What an operator can do with a run in review (decision 0030), or a failed run. The API acts once even when two
 * people click at the same time; the second one sees why nothing happened.
 */
function RunActions({ run, onDone }: { run: Run; onDone: () => void }) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const cancellable = run.state === "pending" || run.state === "waiting";
  if (run.state !== "needs_review" && run.state !== "failed" && !cancellable) return null;
  const last = run.steps.at(-1);
  const notSent = last?.outcome === "not_sent";
  const act = async (path: string, body: object = {}) => {
    if (body && (body as { action?: string }).action === "again" && !window.confirm(t("Send it once more? If it already arrived, they get it twice."))) return;
    if (path === "cancel" && !window.confirm(t("Cancel this run? It stops before its next step and cannot be started again."))) return;
    setBusy(true);
    setMessage("");
    try {
      await api("POST", `/runs/${run.id}/${path}`, body);
      onDone();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (cancellable) {
    return (
      <section aria-label={t("Cancel run")}>
        <p>{t("Cancel stops this run before its next step. Anything already sent stays sent.")}</p>
        <button type="button" disabled={busy} onClick={() => void act("cancel")}>
          {t("Cancel run")}
        </button>
        <p role="alert" className="message error" hidden={!message}>
          {message}
        </p>
      </section>
    );
  }
  if (run.state === "failed") {
    return (
      <section aria-label={t("Retry")}>
        <p>{t("Retry runs the failed step again. Steps that already finished are not repeated.")}</p>
        <button type="button" disabled={busy} onClick={() => void act("retry")}>
          {t("Retry")}
        </button>
        <p role="alert" className="message error" hidden={!message}>
          {message}
        </p>
      </section>
    );
  }
  return (
    <section aria-label={t("Needs you")} className="review">
      <h3>{t("Needs you")}</h3>
      {/* Nothing was sent (a daily send cap): there is nothing to confirm, so "It went through" is not offered. */}
      <p>{notSent ? t("Nothing was sent. Choose what to do.") : t("A message or delivery may or may not have reached its destination, and kymavo cannot tell. Check whether it arrived, then choose.")}</p>
      {last?.error && <p className="message error">{last.error}</p>}
      {last?.input !== null && last?.input !== undefined && (
        <details>
          <summary>{t("What was sent")}</summary>
          <pre aria-label={t("Request that may have gone through")}>{json(last.input)}</pre>
        </details>
      )}
      <ul className="choices">
        {!notSent && (
          <li>
            <button type="button" disabled={busy} onClick={() => void act("resolve", { action: "delivered" })}>
              {t("It went through")}
            </button>{" "}
            {t("I checked, it arrived.")}
          </li>
        )}
        <li>
          <button type="button" disabled={busy} onClick={() => void act("resolve", { action: "again" })}>
            {t("Send again")}
          </button>{" "}
          {t("Send it once more. If it already arrived, they get it twice.")}
        </li>
        <li>
          <button type="button" disabled={busy} onClick={() => void act("resolve", { action: "stop" })}>
            {t("Stop")}
          </button>{" "}
          {t("Do not send, close this.")}
        </li>
      </ul>
      <p role="alert" className="message error" hidden={!message}>
        {message}
      </p>
    </section>
  );
}
