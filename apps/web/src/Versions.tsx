import { useLanguage } from "./Language";
import { useEffect, useState } from "react";
import { api, type Version, type VersionSummary, type Workflow } from "./api";
import { WorkflowHead } from "./Runs";
import "./activity.css";
import { startedAt } from "./lib/activity";
import { canRollbackVersion, describeChange, jsonDiff, type Change } from "./lib/diff";

type Opened = Workflow & { live: Version | null };

function ChangeLine({ c, before, after }: { c: Change; before: unknown; after: unknown }) {
  const { t, language } = useLanguage();
  const d = describeChange(c, before, after, language);
  return (
    <li className={`change ${c.kind}`} title={d.detailPath}>
      <strong>{d.headline}</strong> {t(c.kind)}
      {c.kind !== "added" && d.beforeText && <span className="before"> {d.beforeText}</span>}
      {c.kind === "changed" && " →"}
      {c.kind !== "removed" && d.afterText && <span className="after"> {d.afterText}</span>}
    </li>
  );
}

/**
 * #/w/<id>/versions (A9, Doop frame RKizMLFkzD): every saved version, the changes the selected one made against the
 * version before it, and rollback. A rollback publishes the old definition as a new version, so history is never rewritten.
 */
export function VersionsPage({ workflowId }: { workflowId: string }) {
  const { t, language } = useLanguage();
  const [wf, setWf] = useState<Opened | null>(null);
  const [list, setList] = useState<VersionSummary[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [diff, setDiff] = useState<{ version: Version; previous: Version | null; changes: Change[] } | null>(null);
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
      setDiff({ version, previous, changes: previous ? jsonDiff(previous.definition, version.definition) : [] });
    })().catch((e: Error) => setMessage({ text: e.message, error: true }));
  }, [workflowId, selected]);

  const rollback = async () => {
    if (!diff) return;
    try {
      const v = await api<VersionSummary>("POST", `/workflows/${workflowId}/versions`, { definition: diff.version.definition, publish: true });
      setMessage({ text: t("Version {version} is live, with the definition of version {previous}.", { version: v.version, previous: diff.version.version }), error: false });
      setSelected(v.version);
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    }
  };

  const liveVersion = wf?.live?.version;
  const published = list?.filter((v) => v.published) ?? [];
  const drafts = list?.filter((v) => !v.published) ?? [];
  const table = (rows: VersionSummary[], label: string) => (
    <table className="act-table" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">{t("Version")}</th>
          <th scope="col">{t("Saved")}</th>
          <th scope="col">{t("Status")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => (
          <tr key={v.id} data-selected={v.version === selected || undefined}>
            <td className="bare">
              <button type="button" className="act-version" aria-pressed={v.version === selected} onClick={() => setSelected(v.version)}>
                <span>{t("Version {version}", { version: v.version })}</span>
                {v.version === liveVersion && <span className="act-pill done">{t("Live")}</span>}
              </button>
            </td>
            <td data-label={t("Saved")}><time dateTime={v.createdAt}>{startedAt(v.createdAt, Date.now(), language)}</time></td>
            <td data-label={t("Status")}>{t(v.version === liveVersion ? "Live" : v.published ? "Published" : "Draft")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <main className="page act">
      <WorkflowHead workflowId={workflowId} wf={wf} here="versions" />
      <div className="act-split">
        <section className="act-list motion-page" aria-labelledby="versions-h">
          <div className="act-list-head">
            <div>
              <h2 id="versions-h">{t("Version history")}</h2>
              <p>{t("Compare a saved version with the one before it.")}</p>
            </div>
          </div>
          <p role="status" className={`act-alert ${message.error ? "error" : "ok"}`} hidden={!message.text}>
            {message.text}
          </p>
          {list === null ? (
            <p className="act-muted" role="status">{t("Loading…")}</p>
          ) : list.length === 0 ? (
            <p className="act-muted">{t("Nothing saved yet.")}</p>
          ) : (
            <>
              {published.length === 0 ? <p className="act-muted">{t("No published versions yet.")}</p> : table(published, t("Versions"))}
              {drafts.length > 0 && (
                <details className="act-drafts" open={published.length === 0}>
                  <summary>{t("Show draft versions ({count})", { count: drafts.length })}</summary>
                  <p className="act-muted">{t("Saved or test-run, never published.")}</p>
                  {table(drafts, t("Draft versions"))}
                </details>
              )}
            </>
          )}
        </section>
        <aside className="act-panel act-diff" aria-labelledby="diff-heading">
          {selected !== null && (
            <div className="motion-drawer" key={selected}>
              <p className="act-eyebrow">
                {selected > 1 ? t("Version {version} compared with version {previous}", { version: selected, previous: selected - 1 }) : t("The first version")}
              </p>
              <h2 id="diff-heading">{t("Version {version}", { version: selected })}</h2>
              {!diff ? (
                <p className="act-muted" role="status">{t("Loading…")}</p>
              ) : (
                <>
                  <p>
                    <span className={`act-pill ${diff.version.published ? "done" : ""}`}>{t(diff.version.version === liveVersion ? "Live" : diff.version.published ? "Published" : "Draft")}</span>
                  </p>
                  <p className="act-muted">
                    {selected === 1 ? t("Nothing to compare: this is where the automation started.") : t(diff.changes.length === 1 ? "{count} change against version {version}." : "{count} changes against version {version}.", { count: diff.changes.length, version: selected - 1 })}
                  </p>
                  {diff.changes.length > 0 && (
                    <ul className="act-changes" aria-label={t("Changes")}>
                      {diff.changes.map((c) => (
                        <ChangeLine key={`${c.kind}:${c.path}`} c={c} before={diff.previous?.definition} after={diff.version.definition} />
                      ))}
                    </ul>
                  )}
                  {selected !== liveVersion && (() => {
                    const latestVersion = list?.[0]?.version;
                    const allowRollback = canRollbackVersion({ version: selected, latestVersion, liveVersion, published: diff.version.published });
                    return (
                      <>
                        <button type="button" className="act-button blue" disabled={!allowRollback} onClick={rollback}>{t("Roll back to v{version}", { version: selected })}</button>
                        {!allowRollback && (
                          <p className="act-muted">
                            {t(!diff.version.published ? "Draft versions have not been published yet. Open the editor and turn it on to publish." : "This is already the latest version.")}
                          </p>
                        )}
                      </>
                    );
                  })()}
                  <p className="act-muted">{t("Rolling back publishes that definition as a new version. The earlier history stays as it is.")}</p>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
