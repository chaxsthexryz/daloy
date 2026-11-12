import { useEffect, useState } from "react";
import { api, type Version, type VersionSummary, type Workflow } from "./api";
import { jsonDiff, type Change } from "./lib/diff";

type Opened = Workflow & { live: Version | null };
const show = (v: unknown) => JSON.stringify(v);

function ChangeLine({ c }: { c: Change }) {
  return (
    <li className={`change ${c.kind}`}>
      <code>{c.path || "(whole definition)"}</code> {c.kind}
      {c.kind !== "added" && <span className="before"> {show(c.before)}</span>}
      {c.kind === "changed" && " →"}
      {c.kind !== "removed" && <span className="after"> {show(c.after)}</span>}
    </li>
  );
}

/**
 * #/w/<id>/versions: every saved version, the changes each one made against the version before it,
 * and rollback. A rollback publishes the old definition as a new version, so history is never rewritten.
 */
export function VersionsPage({ workflowId }: { workflowId: string }) {
  const [wf, setWf] = useState<Opened | null>(null);
  const [list, setList] = useState<VersionSummary[] | null>(null);
  const [showDrafts, setShowDrafts] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [diff, setDiff] = useState<{ version: Version; changes: Change[] } | null>(null);
  const [message, setMessage] = useState({ text: "", error: false });

  const load = async () => {
    const [w, l] = await Promise.all([api<Opened>("GET", `/workflows/${workflowId}`), api<VersionSummary[]>("GET", `/workflows/${workflowId}/versions`)]);
    setWf(w);
    setList(l);
    setSelected((s) => s ?? w.live?.version ?? l[0]?.version ?? null);
  };
  useEffect(() => {
    load().catch((e: Error) => setMessage({ text: e.message, error: true }));
  }, [workflowId]);

  useEffect(() => {
    if (selected === null) return;
    setDiff(null);
    const get = (v: number) => api<Version>("GET", `/workflows/${workflowId}/versions/${v}`);
    void (async () => {
      const version = await get(selected);
      const previous = selected > 1 ? await get(selected - 1).catch(() => null) : null;
      setDiff({ version, changes: previous ? jsonDiff(previous.definition, version.definition) : [] });
    })().catch((e: Error) => setMessage({ text: e.message, error: true }));
  }, [workflowId, selected]);

  const rollback = async () => {
    if (!diff) return;
    try {
      const v = await api<VersionSummary>("POST", `/workflows/${workflowId}/versions`, { definition: diff.version.definition, publish: true });
      setMessage({ text: `Version ${v.version} is live, with the definition of version ${diff.version.version}.`, error: false });
      setSelected(v.version);
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    }
  };

  const liveVersion = wf?.live?.version;
  const shown = list?.filter((v) => showDrafts || v.published) ?? [];

  return (
    <main className="page">
      <header className="toolbar plain">
        <a href={`#/w/${workflowId}`}>{wf?.name ?? "Workflow"}</a>
        <h1>Versions</h1>
        <a href={`#/w/${workflowId}/runs`}>Run history</a>
      </header>
      <p role="status" className={`message ${message.error ? "error" : "ok"}`} hidden={!message.text}>
        {message.text}
      </p>
      <label className="check">
        <input type="checkbox" checked={showDrafts} onChange={(e) => setShowDrafts(e.target.checked)} />
        Show drafts (versions saved or test-run but never published)
      </label>
      {list === null ? (
        <p>Loading…</p>
      ) : shown.length === 0 ? (
        <p className="muted">{list.length === 0 ? "Nothing saved yet." : "No published versions yet."}</p>
      ) : (
        <div className="versions">
          <ul className="outline" aria-label="Versions">
            {shown.map((v) => (
              <li key={v.id}>
                <button type="button" aria-pressed={v.version === selected} onClick={() => setSelected(v.version)}>
                  v{v.version} <span className="muted">{v.version === liveVersion ? "live" : v.published ? "published" : "draft"}</span>
                </button>
              </li>
            ))}
          </ul>
          <section aria-labelledby="diff-heading">
            <h2 id="diff-heading">{selected === null ? "Version" : `Version ${selected}`}</h2>
            {!diff ? (
              <p>Loading…</p>
            ) : (
              <>
                <p className="muted">
                  {diff.version.published ? "Published" : "Draft"}, saved {new Date(diff.version.createdAt).toLocaleString()}.
                  {selected === 1 ? " The first version." : ` ${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"} against version ${selected! - 1}.`}
                </p>
                {diff.changes.length > 0 && (
                  <ul className="changes" aria-label="Changes">
                    {diff.changes.map((c) => (
                      <ChangeLine key={`${c.kind}:${c.path}`} c={c} />
                    ))}
                  </ul>
                )}
                {selected !== liveVersion && (
                  <button type="button" className="primary" onClick={rollback}>
                    Roll back to v{selected}
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
