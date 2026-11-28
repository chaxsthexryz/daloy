import "./activity.css";
import "./home.css";
import { useEffect, useState, type CSSProperties } from "react";
import { api, type RunSummary } from "./api";
import { AskRequest } from "./AskRequest";
import { useLanguage } from "./Language";
import { LIVE_RUN_EVENT } from "./lib/live-runs";
import { OnboardingPrompt } from "./Onboarding";
import { duration, PageHead, StatePill } from "./Runs";
import type { User } from "./Team";
import { longDate, startedAt } from "./lib/activity";
import { runKind } from "./lib/states";

export type HomeProblem = {
  id: string;
  kind: "run" | "connection" | "schedule";
  title: string;
  detail: string;
  href: string;
  createdAt: string;
};

export type HomeRunningWorkflow = {
  id: string;
  name: string;
  runsToday: number;
  lastRunAt: string | null;
  lastState: string | null;
};

export type HomePayload = {
  role: User["role"];
  needsYou: { total: number; conversations: number; receipts: number; approvals: number; runs: number };
  problems: HomeProblem[];
  running: HomeRunningWorkflow[];
  recentRuns: RunSummary[];
};

const ICON_PATHS = {
  inbox: "M22 12H16L14 15H10L8 12H2M2 12L5.45 5.11C5.61558 4.77679 5.87083 4.49637 6.18704 4.30028C6.50326 4.10419 6.86792 4.0002 7.24 4H16.76C17.1321 4.0002 17.4967 4.10419 17.813 4.30028C18.1292 4.49637 18.3844 4.77679 18.55 5.11L22 12V18C22 18.5304 21.7893 19.0391 21.4142 19.4142C21.0391 19.7893 20.5304 20 20 20H4C3.46957 20 2.96086 19.7893 2.58579 19.4142C2.21071 19.0391 2 18.5304 2 18V12Z",
  alert: "M12 9V13M12 17H12.01M21.7301 18.0002L13.7301 4.00022C13.5556 3.69243 13.3027 3.43641 12.997 3.25829C12.6913 3.08017 12.3438 2.98633 11.9901 2.98633C11.6363 2.98633 11.2888 3.08017 10.9831 3.25829C10.6774 3.43641 10.4245 3.69243 10.2501 4.00022L2.25005 18.0002C2.07373 18.3056 1.98128 18.6521 1.98206 19.0047C1.98284 19.3573 2.07683 19.7035 2.2545 20.008C2.43217 20.3126 2.6872 20.5648 2.99375 20.7391C3.30029 20.9133 3.64746 21.0034 4.00005 21.0002H20.0001C20.351 20.9999 20.6956 20.9072 20.9993 20.7315C21.3031 20.5558 21.5553 20.3033 21.7306 19.9993C21.9059 19.6954 21.9981 19.3506 21.998 18.9997C21.9979 18.6488 21.9055 18.3041 21.7301 18.0002Z",
  zap: "M3.99999 14C3.81076 14.0007 3.62522 13.9476 3.46495 13.847C3.30467 13.7464 3.17623 13.6024 3.09454 13.4317C3.01286 13.261 2.98129 13.0706 3.00349 12.8827C3.0257 12.6948 3.10077 12.517 3.21999 12.37L13.12 2.17004C13.1943 2.08432 13.2955 2.0264 13.407 2.00577C13.5185 1.98515 13.6337 2.00305 13.7337 2.05654C13.8337 2.11004 13.9126 2.19594 13.9573 2.30015C14.0021 2.40436 14.0101 2.52069 13.98 2.63004L12.06 8.65004C12.0034 8.80156 11.9844 8.96456 12.0046 9.12505C12.0248 9.28553 12.0837 9.43872 12.1761 9.57147C12.2685 9.70421 12.3918 9.81256 12.5353 9.8872C12.6788 9.96185 12.8382 10.0006 13 10H20C20.1892 9.9994 20.3748 10.0525 20.535 10.1531C20.6953 10.2537 20.8238 10.3977 20.9054 10.5684C20.9871 10.7391 21.0187 10.9295 20.9965 11.1174C20.9743 11.3053 20.8992 11.4831 20.78 11.63L10.88 21.83C10.8057 21.9158 10.7045 21.9737 10.593 21.9943C10.4815 22.0149 10.3663 21.997 10.2663 21.9435C10.1663 21.89 10.0874 21.8041 10.0427 21.6999C9.99791 21.5957 9.98991 21.4794 10.02 21.37L11.94 15.35C11.9966 15.1985 12.0156 15.0355 11.9954 14.875C11.9752 14.7145 11.9163 14.5614 11.8239 14.4286C11.7315 14.2959 11.6082 14.1875 11.4647 14.1129C11.3212 14.0382 11.1617 13.9995 11 14H3.99999Z",
  activity: "M22 12H19.52C19.083 11.9991 18.6577 12.1413 18.3091 12.405C17.9606 12.6686 17.708 13.0392 17.59 13.46L15.24 21.82C15.2249 21.8719 15.1933 21.9175 15.15 21.95C15.1067 21.9825 15.0541 22 15 22C14.9459 22 14.8933 21.9825 14.85 21.95C14.8067 21.9175 14.7751 21.8719 14.76 21.82L9.24 2.18C9.22485 2.12807 9.19327 2.08246 9.15 2.05C9.10673 2.01754 9.05409 2 9 2C8.94591 2 8.89327 2.01754 8.85 2.05C8.80673 2.08246 8.77515 2.12807 8.76 2.18L6.41 10.54C6.29246 10.9592 6.04138 11.3285 5.69486 11.592C5.34835 11.8555 4.92532 11.9988 4.49 12H2",
} as const;

function HomeIcon({ name, size = 15 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/** #/ (G5): Today overview replacing Automations KPI summary + top-level Activity feed. */
export function HomePage({ user, initialData }: { user: User; initialData?: HomePayload }) {
  const { t, language } = useLanguage();
  const owner = user.role === "owner";
  const staff = owner || user.role === "operator";
  const canAsk = user.ask === true && staff;

  const [data, setData] = useState<HomePayload | null>(initialData ?? null);
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
    if (initialData) return;
    void load();
    const refresh = () => void load();
    window.addEventListener(LIVE_RUN_EVENT, refresh);
    return () => window.removeEventListener(LIVE_RUN_EVENT, refresh);
  }, [initialData]);

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
            <div className="hm-card-head">
              <span className="card-ico"><HomeIcon name="inbox" size={14} /></span>
              <h2>{t("Needs you")}</h2>
            </div>
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
  const totalRunsToday = (data?.running ?? []).reduce((sum, w) => sum + w.runsToday, 0);
  const automationsHref = owner ? "#/automations" : "#/activity";
  const problemsHref = owner ? "#/automations" : "#/inbox";

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
              <a className="act-button blue" href="#/new">{t("New automation")}</a>
              <a className="act-button" href="#/ai">{t("Build with AI")}</a>
              <a className="act-button" href="#/automations">{t("Automations")}</a>
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
            <div className="hm-kpi-grid">
              <article className="hm-kpi-card motion-stagger-row" style={{ "--i": 0 } as CSSProperties}>
                <div className="hm-kpi-top">
                  <div className="hm-kpi-meta">
                    <span className="hm-kpi-label">{t("Needs you")}</span>
                    <div className="hm-kpi-val">
                      <strong className={`tnum ${data.needsYou.total === 0 ? "ok" : "warn"}`}>{data.needsYou.total}</strong>
                      <span className={`pill ${data.needsYou.total > 0 ? "warn" : "ok"}`}>
                        {t(data.needsYou.total > 0 ? "Waiting" : "Clear")}
                      </span>
                    </div>
                  </div>
                  <span className="hm-kpi-ico"><HomeIcon name="inbox" size={15} /></span>
                </div>
                <a className="hm-kpi-foot" href="#/inbox">
                  <span>{data.needsYou.total > 0 ? t("Open Inbox") : t("All caught up")}</span>
                  <span aria-hidden="true">→</span>
                </a>
              </article>

              <article className="hm-kpi-card motion-stagger-row" style={{ "--i": 1 } as CSSProperties}>
                <div className="hm-kpi-top">
                  <div className="hm-kpi-meta">
                    <span className="hm-kpi-label">{t("Problems")}</span>
                    <div className="hm-kpi-val">
                      <strong className={`tnum ${data.problems.length === 0 ? "ok" : "bad"}`}>{data.problems.length}</strong>
                      <span className={`pill ${data.problems.length > 0 ? "bad" : "ok"}`}>
                        {t(data.problems.length > 0 ? "Needs attention" : "All clear")}
                      </span>
                    </div>
                  </div>
                  <span className="hm-kpi-ico"><HomeIcon name="alert" size={15} /></span>
                </div>
                <a className="hm-kpi-foot" href={problemsHref}>
                  <span>{data.problems.length === 0 ? t("No problems right now") : owner ? t("View automations") : t("Open Inbox")}</span>
                  <span aria-hidden="true">→</span>
                </a>
              </article>

              <article className="hm-kpi-card motion-stagger-row" style={{ "--i": 2 } as CSSProperties}>
                <div className="hm-kpi-top">
                  <div className="hm-kpi-meta">
                    <span className="hm-kpi-label">
                      <i className="live-pulse" aria-hidden="true" /> {t("Live automations")}
                    </span>
                    <div className="hm-kpi-val">
                      <strong className="tnum">{data.running.length}</strong>
                      <span className={`pill ${data.running.length > 0 ? "ok" : "neutral"}`}>
                        {t(data.running.length > 0 ? "On" : "Off")}
                      </span>
                    </div>
                  </div>
                  <span className="hm-kpi-ico"><HomeIcon name="zap" size={15} /></span>
                </div>
                <a className="hm-kpi-foot" href={automationsHref}>
                  <span className="tnum">{t("{count} ran today", { count: totalRunsToday })}</span>
                  <span aria-hidden="true">→</span>
                </a>
              </article>

              <article className="hm-kpi-card motion-stagger-row" style={{ "--i": 3 } as CSSProperties}>
                <div className="hm-kpi-top">
                  <div className="hm-kpi-meta">
                    <span className="hm-kpi-label">{t("Recent runs")}</span>
                    <div className="hm-kpi-val">
                      <strong className="tnum">{data.recentRuns.length}</strong>
                      <span className="pill neutral">{t("Latest")}</span>
                    </div>
                  </div>
                  <span className="hm-kpi-ico"><HomeIcon name="activity" size={15} /></span>
                </div>
                <a className="hm-kpi-foot" href={automationsHref}>
                  <span>{owner ? t("All automations") : t("Workspace activity")}</span>
                  <span aria-hidden="true">→</span>
                </a>
              </article>
            </div>

            <div className="hm-bento">
              <section className="act-card hm-card motion-stagger-row" style={{ "--i": 4 } as CSSProperties} aria-labelledby="home-needs-h">
                <div className="hm-card-head">
                  <span className="card-ico"><HomeIcon name="inbox" size={14} /></span>
                  <h2 id="home-needs-h">{t("Needs you")}</h2>
                  <span className={`pill ${data.needsYou.total > 0 ? "warn" : "ok"} hm-head-pill tnum`}>{data.needsYou.total}</span>
                  <a className="card-link" href="#/inbox">{t("Open Inbox")}</a>
                </div>
                <p className="act-muted">
                  {data.needsYou.total === 0
                    ? t("Nothing is waiting on a person.")
                    : t("{count} items waiting for a person", { count: data.needsYou.total })}
                </p>
                {data.needsYou.total > 0 && (
                  <div className="hm-chips">
                    {data.needsYou.conversations > 0 && <span className="hm-chip tnum">{t("Conversations: {n}", { n: data.needsYou.conversations })}</span>}
                    {data.needsYou.receipts > 0 && <span className="hm-chip tnum">{t("Receipts: {n}", { n: data.needsYou.receipts })}</span>}
                    {data.needsYou.approvals > 0 && <span className="hm-chip tnum">{t("Approvals: {n}", { n: data.needsYou.approvals })}</span>}
                    {data.needsYou.runs > 0 && <span className="hm-chip tnum">{t("Checks: {n}", { n: data.needsYou.runs })}</span>}
                  </div>
                )}
              </section>

              <section className="act-card hm-card motion-stagger-row" style={{ "--i": 5 } as CSSProperties} aria-labelledby="home-problems-h">
                <div className="hm-card-head">
                  <span className="card-ico"><HomeIcon name="alert" size={14} /></span>
                  <h2 id="home-problems-h">{t("Problems")}</h2>
                  <span className={`pill ${data.problems.length > 0 ? "bad" : "ok"} hm-head-pill tnum`}>{data.problems.length}</span>
                </div>
                {data.problems.length === 0 ? (
                  <div className="hm-healthy">
                    <span className="pill ok"><i className="dot" aria-hidden="true" />{t("All clear")}</span>
                    <p className="act-muted">{t("No problems right now")}</p>
                  </div>
                ) : (
                  <ul className="hm-list">
                    {data.problems.slice(0, 4).map((p) => (
                      <li key={p.id}>
                        <div className="hm-row-main">
                          <strong>{p.title}</strong>
                          <span>{p.detail}</span>
                        </div>
                        <a className="act-button hm-fix-btn" href={p.href}>{t("Fix")}</a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section className="act-card hm-card motion-stagger-row" style={{ "--i": 6 } as CSSProperties} aria-labelledby="home-ran-h">
              <div className="hm-card-head">
                <span className="card-ico"><HomeIcon name="activity" size={14} /></span>
                <h2 id="home-ran-h">{t("What ran")}</h2>
                {owner && <a className="card-link" href="#/automations">{t("All automations")}</a>}
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
                      <span className="tnum">
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
                <div className="hm-table-wrap">
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
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
