import { useEffect, useState } from "react";
import { api, FINISHED, type Run, type RunSummary, type Workflow } from "./api";
import { DeliveryList, type Delivery } from "./Connections";

/** Polls a run until it finishes, so the page shows each step as the worker records it. A new `reload` value polls again. */
export function useRun(runId: string | null, reload = 0) {
  const [run, setRun] = useState<Run | null>(null);
  useEffect(() => {
    setRun(null);
    if (!runId) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      const r = await api<Run>("GET", `/runs/${runId}`).catch(() => null);
      if (stopped) return;
      if (r) setRun(r);
      if (!r || !FINISHED.has(r.state)) timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId, reload]);
  return run;
}

/** Time between two timestamps ("850 ms", "1.2 s", "3 min"), or "not finished" while the second one is missing. */
export function duration(from: string, to: string | null): string {
  if (!to) return "not finished";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}

const SUPERSEDED = "Superseded: its booking was rescheduled or cancelled. It stops at its next step and sends nothing more.";

const kind = (r: { test: boolean; live: boolean; aiLive?: boolean }) => (r.test ? (r.live ? "test run, live calls" : r.aiLive ? "test run, real AI, other calls mocked" : "test run, mocked calls") : "live run");
const json = (v: unknown) => JSON.stringify(v, null, 2);
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

const FILTERS = { all: "", live: "&test=false", test: "&test=true", review: "&review=true" } as const;

/** #/w/<id>/runs: the latest 50 runs of one workflow. */
export function RunsPage({ workflowId }: { workflowId: string }) {
  const [wf, setWf] = useState<Workflow | null>(null);
  const [filter, setFilter] = useState<keyof typeof FILTERS>("all");
  const [list, setList] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Workflow>("GET", `/workflows/${workflowId}`).then(setWf, (e: Error) => setError(e.message));
  }, [workflowId]);
  useEffect(() => {
    setList(null);
    api<RunSummary[]>("GET", `/runs?workflowId=${workflowId}${FILTERS[filter]}`).then(setList, (e: Error) => setError(e.message));
  }, [workflowId, filter]);

  return (
    <main className="page">
      <header className="toolbar plain">
        <a href={`#/w/${workflowId}`}>{wf?.name ?? "Workflow"}</a>
        <h1>Run history</h1>
        <a href={`#/w/${workflowId}/versions`}>Versions</a>
      </header>
      <div className="field inline">
        <label htmlFor="run-filter">Show</label>
        <select id="run-filter" value={filter} onChange={(e) => setFilter(e.target.value as keyof typeof FILTERS)}>
          <option value="all">All runs</option>
          <option value="live">Live runs</option>
          <option value="test">Test runs</option>
          <option value="review">Needs review</option>
        </select>
      </div>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {list === null ? (
        <p>Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="muted">{list.length === 1 ? "1 run" : `Latest ${list.length} runs, newest first`}</caption>
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">State</th>
                <th scope="col">Kind</th>
                <th scope="col">Version</th>
                <th scope="col">Duration</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={`#/runs/${r.id}`}>{new Date(r.createdAt).toLocaleString()}</a>
                  </td>
                  <td>
                    <span className={`badge ${r.state}`}>{r.state.replace("_", " ")}</span>
                    {r.needsReview && r.state !== "needs_review" && <span className="badge needs_review"> delivery needs review</span>}
                    {r.superseded && (
                      <span className="badge" title={SUPERSEDED}>
                        {" "}
                        superseded
                      </span>
                    )}
                  </td>
                  <td>{kind(r)}</td>
                  <td>v{r.version}</td>
                  <td>{duration(r.createdAt, r.finishedAt)}</td>
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
export function RunPage({ runId }: { runId: string }) {
  const [reload, setReload] = useState(0);
  const run = useRun(runId, reload);
  if (!run) return <main className="page">Loading…</main>;
  return (
    <main className="page">
      <header className="toolbar plain">
        <a href={`#/w/${run.workflowId}/runs`}>Run history</a>
        <h1>Run</h1>
        <span className="muted status">
          v{run.version} · started {new Date(run.createdAt).toLocaleString()} · {duration(run.createdAt, run.finishedAt)}
        </span>
      </header>
      <h2>Trigger data</h2>
      <pre aria-label="Trigger data">{json(run.triggerPayload)}</pre>
      <RunActions run={run} onDone={() => setReload((n) => n + 1)} />
      <h2>Steps</h2>
      <RunResult run={run} />
      <RunDeliveries runId={runId} />
    </main>
  );
}

/** Sheets rows and Slack notes this run queued. They are delivered apart from the run, so they have their own state. */
function RunDeliveries({ runId }: { runId: string }) {
  const [list, setList] = useState<Delivery[]>([]);
  const load = () => api<Delivery[]>("GET", `/deliveries?runId=${runId}`).then(setList, () => setList([]));
  useEffect(() => void load(), [runId]);
  if (list.length === 0) return null;
  return (
    <>
      <h2>Deliveries</h2>
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
        <p>Retry runs the step {last ? `"${last.stepId}"` : ""} once more, with the same Idempotency-Key.</p>
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
    <section aria-label="Needs review" className="review">
      <h2>Needs review</h2>
      <p>
        The step {last ? `"${last.stepId}"` : ""} may or may not have reached the receiver, and it is not safe to send again on its own. Check with the
        receiver, then choose.
      </p>
      {last?.error && <p className="message error">{last.error}</p>}
      {last?.input !== null && last?.input !== undefined && <pre aria-label="Request that may have gone through">{json(last.input)}</pre>}
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void act("resolve", { action: "delivered" })}>
          It went through
        </button>
        <button type="button" disabled={busy} onClick={() => void act("resolve", { action: "again" })}>
          Send again
        </button>
        <button type="button" disabled={busy} onClick={() => void act("resolve", { action: "stop" })}>
          Stop
        </button>
      </div>
      <p className="muted">
        Send again sends the same request once more, with the same Idempotency-Key. A receiver that does not deduplicate may get it twice.
      </p>
      <p role="alert" className="message error" hidden={!message}>
        {message}
      </p>
    </section>
  );
}
