import { useEffect, useState } from "react";
import { api, FINISHED, type Run, type RunSummary, type Workflow } from "./api";

/** Polls a run until it finishes, so the page shows each step as the worker records it. */
export function useRun(runId: string | null) {
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
  }, [runId]);
  return run;
}

/** Time between two timestamps ("850 ms", "1.2 s", "3 min"), or "not finished" while the second one is missing. */
export function duration(from: string, to: string | null): string {
  if (!to) return "not finished";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}

const kind = (r: { test: boolean; live: boolean }) => (r.test ? (r.live ? "test run, live calls" : "test run, mocked calls") : "live run");
const json = (v: unknown) => JSON.stringify(v, null, 2);

/** One run's steps: state, branch, attempt, timing, and the input and output the worker stored (secrets masked by the API). */
export function RunResult({ run }: { run: Run }) {
  return (
    <div className="run" aria-live="polite">
      <p>
        <span className={`badge ${run.state}`}>{run.state}</span> {kind(run)}
      </p>
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

const FILTERS = { all: "", live: "&test=false", test: "&test=true" } as const;

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
                    <span className={`badge ${r.state}`}>{r.state}</span>
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
  const run = useRun(runId);
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
      <h2>Steps</h2>
      <RunResult run={run} />
    </main>
  );
}
