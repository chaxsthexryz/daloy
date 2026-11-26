import "./activity.css";
import "./home.css";
import { useEffect, useState } from "react";
import { api, type RunSummary } from "./api";
import { AskRequest } from "./AskRequest";
import { useLanguage } from "./Language";
import { LIVE_RUN_EVENT } from "./lib/live-runs";
import { OnboardingPrompt } from "./Onboarding";
import { duration, PageHead, StatePill } from "./Runs";
import type { User } from "./Team";
import { longDate, startedAt } from "./lib/activity";
import { runKind } from "./lib/states";

type HomeProblem = {
  id: string;
  kind: "run" | "connection" | "schedule";
  title: string;
  detail: string;
  href: string;
  createdAt: string;
};

type HomeRunningWorkflow = {
  id: string;
  name: string;
  runsToday: number;
  lastRunAt: string | null;
  lastState: string | null;
};

type HomePayload = {
  role: User["role"];
  needsYou: { total: number; conversations: number; receipts: number; approvals: number; runs: number };
  problems: HomeProblem[];
  running: HomeRunningWorkflow[];
  recentRuns: RunSummary[];
};

/** #/ (G5): Today overview replacing Automations KPI summary + top-level Activity feed. */
export function HomePage({ user }: { user: User }) {
  const { t, language } = useLanguage();
  const owner = user.role === "owner";
  const staff = owner || user.role === "operator";
  const canAsk = user.ask === true && staff;

  const [data, setData] = useState<HomePayload | null>(null);
  const [query, setQuery] = useState("");
  const [filteredRuns, setFilteredRuns] = useState<RunSummary[] | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Manila");
      const next = await api<HomePayload>("GET", `/home?tz=${tz}`);
      setData(next);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener(LIVE_RUN_EVENT, refresh);
    return () => window.removeEventListener(LIVE_RUN_EVENT, refresh);
  }, []);

  useEffect(() => {
    if (!staff) return;
    const trimmed = query.trim();
    setFilteredRuns(null);
    if (!trimmed) return;
    let current = true;
    api<RunSummary[]>("GET", `/runs?q=${encodeURIComponent(trimmed)}`).then(
      (rows) => current && setFilteredRuns(rows),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [query, staff]);

  if (!staff) {
    return (
      <main className="page act">
        <PageHead crumbs={[]} title={t("Today")} sub={longDate(Date.now(), language)} />
        <div className="hm-body motion-page">
          <p role="alert" className="act-alert error" hidden={!error}>{error}</p>
          <section className="act-card hm-card">
            <h2>{t("Needs you")}</h2>
            <p className="act-muted">
              {data && data.needsYou.approvals > 0
                ? t("Your account has {count} pending approvals assigned to you.", { count: data.needsYou.approvals })
                : t("Nothing is waiting on a person.")}
            </p>
            <div className="hm-actions">
              <a className="act-button" href="#/settings">{t("Settings")}</a>
            </div>
          </section>
        </div>
      </main>
    );
  }

  const trimmedQuery = query.trim().toLowerCase();
  const recent = data?.recentRuns ?? [];
  const localMatches = trimmedQuery
    ? recent.filter(
        (r) =>
          (r.reference ?? "").toLowerCase().includes(trimmedQuery) ||
          r.workflowName.toLowerCase().includes(trimmedQuery),
      )
    : recent;
  const shownRuns = trimmedQuery ? (filteredRuns ?? localMatches) : recent;

  return (
    <main className="page act">
      {owner && <OnboardingPrompt />}
      <PageHead
        crumbs={[]}
        title={t("Today")}
        sub={longDate(Date.now(), language)}
        actions={
          owner ? (
            <div className="hm-actions">
              <a className="act-button" href="#/automations">{t("Automations")}</a>
              <a className="act-button blue" href="#/new">{t("New automation")}</a>
            </div>
          ) : undefined
        }
      />
      <div className="hm-body motion-page">
        <p role="alert" className="act-alert error" hidden={!error}>{error}</p>
        {data === null ? (
          <p className="act-muted" role="status">{t("Loading…")}</p>
        ) : (
          <>
            <div className="hm-top">
              <section className="act-card hm-card" aria-labelledby="home-needs-h">
                <div>
                  <h2 id="home-needs-h">{t("Needs you")}</h2>
                  <div className="hm-stat">
                    <strong className={data.needsYou.total === 0 ? "ok" : "warn"}>{data.needsYou.total}</strong>
                    <span className="act-muted">
                      {data.needsYou.total === 0
                        ? t("Nothing is waiting on a person.")
                        : t("{count} items waiting for a person", { count: data.needsYou.total })}
                    </span>
                  </div>
                </div>
                {data.needsYou.total > 0 && (
                  <div className="hm-chips">
                    {data.needsYou.conversations > 0 && <span className="hm-chip">{t("Conversations: {n}", { n: data.needsYou.conversations })}</span>}
                    {data.needsYou.receipts > 0 && <span className="hm-chip">{t("Receipts: {n}", { n: data.needsYou.receipts })}</span>}
                    {data.needsYou.approvals > 0 && <span className="hm-chip">{t("Approvals: {n}", { n: data.needsYou.approvals })}</span>}
                    {data.needsYou.runs > 0 && <span className="hm-chip">{t("Checks: {n}", { n: data.needsYou.runs })}</span>}
                  </div>
                )}
                <div className="hm-actions">
                  <a className={data.needsYou.total > 0 ? "act-button blue" : "act-button"} href="#/inbox">
                    {data.needsYou.total > 0 ? t("Open Inbox") : t("All caught up")}
                  </a>
                </div>
              </section>

              <section className="act-card hm-card" aria-labelledby="home-problems-h">
                <div>
                  <h2 id="home-problems-h">{t("Problems")}</h2>
                  <div className="hm-stat">
                    <strong className={data.problems.length === 0 ? "ok" : "bad"}>{data.problems.length}</strong>
                    <span className="act-muted">
                      {data.problems.length === 0 ? t("No problems right now") : t("Needs attention")}
                    </span>
                  </div>
                </div>
                {data.problems.length > 0 && (
                  <ul className="hm-list">
                    {data.problems.slice(0, 4).map((p) => (
                      <li key={p.id}>
                        <div className="hm-row-main">
                          <strong>{p.title}</strong>
                          <span>{p.detail}</span>
                        </div>
                        <a className="act-button" href={p.href}>{t("Fix")}</a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section className="act-card" aria-labelledby="home-ran-h">
              <div className="hm-section-head">
                <h2 id="home-ran-h">{t("What ran")}</h2>
                {owner && <a className="act-link" href="#/automations">{t("All automations")}</a>}
              </div>

              {data.running.length === 0 ? (
                <p className="act-muted">
                  {t("No automations are turned on yet.")}{" "}
                  {owner && <a href="#/new">{t("Turn one on")}</a>}
                </p>
              ) : (
                <div className="hm-running-grid" aria-label={t("Running automations")}>
                  {data.running.map((w) => (
                    <a key={w.id} className="hm-running-item" href={`#/a/${w.id}`}>
                      <strong>{w.name}</strong>
                      <span>
                        {w.runsToday > 0
                          ? t("{count} ran today", { count: w.runsToday })
                          : t("No live runs yet today")}
                      </span>
                    </a>
                  ))}
                </div>
              )}

              <div className="hm-section-head">
                <h3>{t("Recent activity")}</h3>
                <div className="act-filters">
                  <input
                    type="search"
                    aria-label={t("Search recent runs")}
                    placeholder={t("Search reference or automation")}
                    value={query}
                    maxLength={100}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {canAsk && (
                    <button type="button" className="act-button" aria-expanded={askOpen} onClick={() => setAskOpen((was) => !was)}>
                      {askOpen ? t("Hide question helper") : t("Ask about a request")}
                    </button>
                  )}
                </div>
              </div>

              {canAsk && askOpen && <AskRequest />}

              {shownRuns.length === 0 ? (
                <p className="act-muted">{t(query.trim() ? "Nothing matches." : "Nothing has happened yet.")}</p>
              ) : (
                <table className="act-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("Reference")}</th>
                      <th scope="col">{t("Automation")}</th>
                      <th scope="col">{t("Started")}</th>
                      <th scope="col">{t("Took")}</th>
                      <th scope="col">{t("Status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRuns.map((r) => (
                      <tr key={r.id}>
                        <td className="ref">
                          <a href={`#/runs/${r.id}`}>{r.reference ?? t(runKind(r))}</a>
                        </td>
                        <td className="strong" data-label={t("Automation")}>{r.workflowName}</td>
                        <td data-label={t("Started")}>
                          <time dateTime={r.createdAt}>{startedAt(r.createdAt, Date.now(), language)}</time>
                        </td>
                        <td data-label={t("Took")}>{t(duration(r.createdAt, r.finishedAt))}</td>
                        <td className="bare"><StatePill run={r} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
