import { useEffect, useState } from "react";
import { api, type Run, type RunSummary, type Version, type Workflow } from "./api";
import { DeliveryList, type Delivery } from "./Connections";
import { AutomationTabs, Header } from "./Nav";
import { RunFlow } from "./FlowCanvas";
import type { Draft } from "./lib/graph";
import { pollDelay, takingLonger } from "./lib/poll";
import { fixFor, ownerError, plainState, runKind } from "./lib/states";

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

export const TAKING_LONGER = "Taking longer than usual. Tell the person who runs Daloy.";
const SUPERSEDED = "Superseded: its booking was rescheduled or cancelled. It stops at its next step and sends nothing more.";

const kind = (r: { test: boolean; live: boolean; aiLive?: boolean }) => (r.test ? (r.live ? "test run, live calls" : r.aiLive ? "test run, real AI, other calls mocked" : "test run, mocked calls") : "live run");
const json = (v: unknown) => JSON.stringify(v, null, 2);

/** The owner-facing state of a run (Done, Waiting, Needs you, Problem, Working), with its note. The raw state stays in the technician block. */
function StateLabel({ run }: { run: { state: string; createdAt: string; needsReview: boolean; superseded?: boolean } }) {
  const s = plainState(run);
  return (
    <>
      <span className={`state ${s.key}`}>{s.label}</span>
      {s.note && <span className="muted"> {s.note}</span>}
    </>
  );
}
// A named approval's step output holds who answered and when (decision 0022).
function decided(output: unknown): string | null {
  const o = output as { decidedBy?: unknown; decidedAt?: unknown } | null;
  return typeof o?.decidedBy === "string" && typeof o.decidedAt === "string" ? `Decided by ${o.decidedBy} at ${new Date(o.decidedAt).toLocaleString()}` : null;
}

// A delay whose time had passed and that has no late edge ends the run (decision 0031).
const skipped = (output: unknown) => {
  const s = (output as { skipped?: unknown } | null)?.skipped;
  return typeof s === "string" ? `Skipped: ${s}` : null;
};

/** One run's steps: state, branch, attempt, timing, and the input and output the worker stored (secrets masked by the API). */
export function RunResult({ run }: { run: Run }) {
  return (
    <div className="run" aria-live="polite">
      <p>
        <span className={`badge ${run.state}`}>{run.state}</span> {kind(run)}
      </p>
      {run.superseded && <p className="message">{SUPERSEDED}</p>}
      {run.error && <p className="message error">{run.error}</p>}
      <ol className="steps">
        {run.steps.map((s) => (
          <li key={s.id}>
            <span className={`badge ${s.state}`}>{s.state}</span> {s.stepId}
            {s.attempt > 1 && <span className="muted"> attempt {s.attempt}</span>}
            {s.branch && <span className="muted"> → {s.branch}</span>}
            <span className="muted"> · {duration(s.createdAt, s.finishedAt)}</span>
            {s.inputTokens !== null && <span className="muted"> · {s.inputTokens} in, {s.outputTokens ?? 0} out tokens</span>}
            {s.error && <p className="message error">{s.error}</p>}
            {decided(s.output) && <p className="muted">{decided(s.output)}</p>}
            {skipped(s.output) && <p className="muted">{skipped(s.output)}</p>}
            {s.outcome && <p className="muted">Outcome: {s.outcome.replace("_", " ")}</p>}
            {s.resolvedBy && s.resolvedAt && (
              <p className="muted">
                Answered by {s.resolvedBy} at {new Date(s.resolvedAt).toLocaleString()}
              </p>
            )}
            {s.input !== null && (
              <details>
                <summary>Input</summary>
                <pre aria-label={`Input of ${s.stepId}`}>{json(s.input)}</pre>
              </details>
            )}
            {s.output !== null && <pre aria-label={`Output of ${s.stepId}`}>{json(s.output)}</pre>}
          </li>
        ))}
      </ol>
    </div>
  );
}

const FILTERS = { all: "", live: "&test=false", test: "&test=true", review: "&review=true", problem: "&state=problem", waiting: "&state=waiting" } as const;

/** #/activity: the latest 50 runs of every automation, or #/w/<id>/runs: of one, under its tabs. */
export function RunsPage({ workflowId }: { workflowId?: string }) {
  const [wf, setWf] = useState<(Workflow & { live: unknown }) | null>(null);
  const [filter, setFilter] = useState<keyof typeof FILTERS>("all");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState("");
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

  return (
    <main className="page">
      {workflowId ? (
        <>
          <p>
            <a href="#/">Automations</a>
          </p>
          <h1>{wf?.name ?? "Activity"}</h1>
          <AutomationTabs id={workflowId} here="activity" overview={!!wf?.setup && !!wf.live} />
        </>
      ) : (
        <>
          <Header title="Activity" />
          <div className="field">
            <label htmlFor="run-find">Find a request or automation</label>
            <input id="run-find" type="search" value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </>
      )}
      <div className="field inline">
        <label htmlFor="run-filter">Show</label>
        <select id="run-filter" value={filter} onChange={(e) => setFilter(e.target.value as keyof typeof FILTERS)}>
          <option value="all">Everything</option>
          <option value="live">Real runs</option>
          <option value="test">Previews</option>
          <option value="review">Needs you</option>
          <option value="problem">Problem</option>
          <option value="waiting">Waiting</option>
        </select>
      </div>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {list === null ? (
        <p>Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">{query.trim() ? "Nothing matches." : "Nothing has happened yet."}</p>
      ) : (
        <div className="table-wrap">
          <table className="table cards">
            <caption className="muted">{list.length === 1 ? "1 item" : `Latest ${list.length} items, newest first`}</caption>
            <thead>
              <tr>
                <th scope="col">Started</th>
                {!workflowId && <th scope="col">Automation</th>}
                {!workflowId && <th scope="col">Request</th>}
                <th scope="col">Result</th>
                <th scope="col">Kind</th>
                <th scope="col">Took</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td data-label="Started">
                    <a href={`#/runs/${r.id}`}>{new Date(r.createdAt).toLocaleString()}</a>
                  </td>
                  {!workflowId && <td data-label="Automation">{r.workflowName}</td>}
                  {!workflowId && <td data-label="Request">{r.reference ?? ""}</td>}
                  <td data-label="Result">
                    <StateLabel run={r} />
                  </td>
                  <td data-label="Kind">{runKind(r)}</td>
                  <td data-label="Took">{duration(r.createdAt, r.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

/** #/runs/<id>: one run with its trigger payload and every step attempt. Polls until the run finishes. */
export function RunPage({ runId, owner }: { runId: string; owner: boolean }) {
  const [reload, setReload] = useState(0);
  const { run, error } = useRun(runId, reload);
  if (!run) {
    return (
      <main className="page">
        {error ? (
          <>
            <p role="alert">Couldn't load this run. Trying again.</p>
            <button type="button" onClick={() => setReload((n) => n + 1)}>
              Retry
            </button>
          </>
        ) : (
          "Loading…"
        )}
      </main>
    );
  }
  const working = run.state === "pending" || run.state === "running" || run.state === "queued";
  return (
    <main className="page">
      <header className="toolbar plain">
        <a href={`#/w/${run.workflowId}/runs`}>Activity</a>
        <h1>What happened</h1>
      </header>
      {error && <p role="alert" className="message error">Couldn't refresh. Trying again.</p>}
      {working && takingLonger(run.createdAt) && <p className="message">{TAKING_LONGER}</p>}
      <p aria-live="polite">
        <StateLabel run={run} /> <span className="muted">{runKind(run)} · started {new Date(run.createdAt).toLocaleString()} · {duration(run.createdAt, run.finishedAt)}</span>
      </p>
      {run.superseded && <p className="message">{SUPERSEDED}</p>}
      {run.error && <RunError error={run.error} owner={owner} />}
      <RunActions run={run} onDone={() => setReload((n) => n + 1)} />
      <RunDeliveries runId={runId} />
      <RunPath run={run} />
      <details className="technician">
        <summary>Details for a technician</summary>
        <p className="muted">
          Raw state: {run.state} · version v{run.version} · {kind(run)}
        </p>
        {run.error && <pre aria-label="Full error">{run.error}</pre>}
        <h2>Trigger data</h2>
        <pre aria-label="Trigger data">{json(run.triggerPayload)}</pre>
        <h2>Steps</h2>
        <RunResult run={run} />
      </details>
    </main>
  );
}

/** The run's error in the owner's words, with a link to the page that fixes it when the error says which (owners only). */
function RunError({ error, owner }: { error: string; owner: boolean }) {
  const fix = owner ? fixFor(error) : null;
  return (
    <p className="message error">
      {ownerError(error)}
      {fix && (
        <>
          {" "}
          <a href={fix.href}>{fix.label}</a>
        </>
      )}
    </p>
  );
}

/** The path this run took: the version's diagram, redrawn on every poll with the state of each step (read only). */
function RunPath({ run }: { run: Run }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setDraft(null);
    setFailed(false);
    api<Version>("GET", `/workflows/${run.workflowId}/versions/${run.version}`).then(
      (v) => setDraft(v.definition as Draft),
      () => setFailed(true),
    );
  }, [run.workflowId, run.version]);
  if (failed) return <p className="muted">The diagram could not load. The steps are listed under Details for a technician.</p>;
  if (!draft) return null;
  return (
    <section className="run-path" aria-label="Path it took">
      <h2>Path it took</h2>
      <RunFlow draft={draft} run={run} />
    </section>
  );
}

/** Sheets rows and Slack notes this run queued. They are delivered apart from the run, so they have their own state. */
function RunDeliveries({ runId }: { runId: string }) {
  const [list, setList] = useState<Delivery[]>([]);
  const [failed, setFailed] = useState(false);
  const load = () =>
    api<Delivery[]>("GET", `/deliveries?runId=${runId}`).then(
      (l) => {
        setFailed(false);
        setList(l);
      },
      () => setFailed(true),
    );
  useEffect(() => void load(), [runId]);
  if (failed) return <p role="alert">Couldn't load deliveries. <button type="button" onClick={() => void load()}>Retry</button></p>;
  if (list.length === 0) return null;
  return (
    <>
      <h2>Where it was sent</h2>
      <DeliveryList deliveries={list} onChange={load} />
    </>
  );
}

/**
 * What an operator can do with a run in review (decision 0030), or a failed run. The API acts once even when two
 * people click at the same time; the second one sees why nothing happened.
 */
function RunActions({ run, onDone }: { run: Run; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (run.state !== "needs_review" && run.state !== "failed") return null;
  const last = run.steps.at(-1);
  const act = async (path: string, body: object = {}) => {
    if (body && (body as { action?: string }).action === "again" && !window.confirm("Send it once more? If it already arrived, they get it twice.")) return;
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
  if (run.state === "failed") {
    return (
      <section aria-label="Retry">
        <p>Retry runs the failed step again. Steps that already finished are not repeated.</p>
        <button type="button" disabled={busy} onClick={() => void act("retry")}>
          Retry
        </button>
        <p role="alert" className="message error" hidden={!message}>
          {message}
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Needs you" className="review">
      <h2>Needs you</h2>
      <p>A message or delivery may or may not have reached its destination, and Daloy cannot tell. Check whether it arrived, then choose.</p>
      {last?.error && <p className="message error">{last.error}</p>}
      {last?.input !== null && last?.input !== undefined && (
        <details>
          <summary>What was sent</summary>
          <pre aria-label="Request that may have gone through">{json(last.input)}</pre>
        </details>
      )}
      <ul className="choices">
        <li>
          <button type="button" disabled={busy} onClick={() => void act("resolve", { action: "delivered" })}>
            It went through
          </button>{" "}
          I checked, it arrived.
        </li>
        <li>
          <button type="button" disabled={busy} onClick={() => void act("resolve", { action: "again" })}>
            Send again
          </button>{" "}
          Send it once more. If it already arrived, they get it twice.
        </li>
        <li>
          <button type="button" disabled={busy} onClick={() => void act("resolve", { action: "stop" })}>
            Stop
          </button>{" "}
          Do not send, close this.
        </li>
      </ul>
      <p role="alert" className="message error" hidden={!message}>
        {message}
      </p>
    </section>
  );
}
