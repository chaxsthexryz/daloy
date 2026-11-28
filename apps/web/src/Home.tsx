import "./activity.css";
import "./home.css";
import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { api, type RunSummary } from "./api";
import { APP_LOGO, AppMark } from "./AppMark";
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

export type HomeConnection = {
  provider: string;
  status: string;
};

export type TrendDay = {
  key: string;
  shortLabel: string;
  dayName: string;
  total: number;
  ok: number;
  failed: number;
  waiting: number;
};

export type HealthSummary = {
  total: number;
  ok: number;
  waiting: number;
  failed: number;
  pct: number;
};

const ICON_PATHS = {
  inbox: "M22 12H16L14 15H10L8 12H2M2 12L5.45 5.11C5.61558 4.77679 5.87083 4.49637 6.18704 4.30028C6.50326 4.10419 6.86792 4.0002 7.24 4H16.76C17.1321 4.0002 17.4967 4.10419 17.813 4.30028C18.1292 4.49637 18.3844 4.77679 18.55 5.11L22 12V18C22 18.5304 21.7893 19.0391 21.4142 19.4142C21.0391 19.7893 20.5304 20 20 20H4C3.46957 20 2.96086 19.7893 2.58579 19.4142C2.21071 19.0391 2 18.5304 2 18V12Z",
  alert: "M12 9V13M12 17H12.01M21.7301 18.0002L13.7301 4.00022C13.5556 3.69243 13.3027 3.43641 12.997 3.25829C12.6913 3.08017 12.3438 2.98633 11.9901 2.98633C11.6363 2.98633 11.2888 3.08017 10.9831 3.25829C10.6774 3.43641 10.4245 3.69243 10.2501 4.00022L2.25005 18.0002C2.07373 18.3056 1.98128 18.6521 1.98206 19.0047C1.98284 19.3573 2.07683 19.7035 2.2545 20.008C2.43217 20.3126 2.6872 20.5648 2.99375 20.7391C3.30029 20.9133 3.64746 21.0034 4.00005 21.0002H20.0001C20.351 20.9999 20.6956 20.9072 20.9993 20.7315C21.3031 20.5558 21.5553 20.3033 21.7306 19.9993C21.9059 19.6954 21.9981 19.3506 21.998 18.9997C21.9979 18.6488 21.9055 18.3041 21.7301 18.0002Z",
  zap: "M3.99999 14C3.81076 14.0007 3.62522 13.9476 3.46495 13.847C3.30467 13.7464 3.17623 13.6024 3.09454 13.4317C3.01286 13.261 2.98129 13.0706 3.00349 12.8827C3.0257 12.6948 3.10077 12.517 3.21999 12.37L13.12 2.17004C13.1943 2.08432 13.2955 2.0264 13.407 2.00577C13.5185 1.98515 13.6337 2.00305 13.7337 2.05654C13.8337 2.11004 13.9126 2.19594 13.9573 2.30015C14.0021 2.40436 14.0101 2.52069 13.98 2.63004L12.06 8.65004C12.0034 8.80156 11.9844 8.96456 12.0046 9.12505C12.0248 9.28553 12.0837 9.43872 12.1761 9.57147C12.2685 9.70421 12.3918 9.81256 12.5353 9.8872C12.6788 9.96185 12.8382 10.0006 13 10H20C20.1892 9.9994 20.3748 10.0525 20.535 10.1531C20.6953 10.2537 20.8238 10.3977 20.9054 10.5684C20.9871 10.7391 21.0187 10.9295 20.9965 11.1174C20.9743 11.3053 20.8992 11.4831 20.78 11.63L10.88 21.83C10.8057 21.9158 10.7045 21.9737 10.593 21.9943C10.4815 22.0149 10.3663 21.997 10.2663 21.9435C10.1663 21.89 10.0874 21.8041 10.0427 21.6999C9.99791 21.5957 9.98991 21.4794 10.02 21.37L11.94 15.35C11.9966 15.1985 12.0156 15.0355 11.9954 14.875C11.9752 14.7145 11.9163 14.5614 11.8239 14.4286C11.7315 14.2959 11.6082 14.1875 11.4647 14.1129C11.3212 14.0382 11.1617 13.9995 11 14H3.99999Z",
  activity: "M22 12H19.52C19.083 11.9991 18.6577 12.1413 18.3091 12.405C17.9606 12.6686 17.708 13.0392 17.59 13.46L15.24 21.82C15.2249 21.8719 15.1933 21.9175 15.15 21.95C15.1067 21.9825 15.0541 22 15 22C14.9459 22 14.8933 21.9825 14.85 21.95C14.8067 21.9175 14.7751 21.8719 14.76 21.82L9.24 2.18C9.22485 2.12807 9.19327 2.08246 9.15 2.05C9.10673 2.01754 9.05409 2 9 2C8.94591 2 8.89327 2.01754 8.85 2.05C8.80673 2.08246 8.77515 2.12807 8.76 2.18L6.41 10.54C6.29246 10.9592 6.04138 11.3285 5.69486 11.592C5.34835 11.8555 4.92532 11.9988 4.49 12H2",
  checkCircle: "M9 12L11 14L15 10M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  fileText: "M14 3v4a1 1 0 0 0 1 1h4M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2zM9 9h1M9 13h6M9 17h6",
} as const;

const APP_NAMES: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  google_sheets: "Google Sheets",
  google_drive: "Google Drive",
  google_calendar: "Google Calendar",
  slack: "Slack",
  teams: "Microsoft Teams",
  telegram: "Telegram",
  airtable: "Airtable",
  notion: "Notion",
  trello: "Trello",
  discord: "Discord",
  shopify: "Shopify",
  paymongo: "PayMongo",
  meta_messenger: "Messenger & Instagram",
  whatsapp: "WhatsApp",
  lalamove: "Lalamove",
};

const QUICK_CONNECT_ORDER = ["gmail", "google_sheets", "slack", "meta_messenger"] as const;
const WAITING_STATES = new Set(["waiting", "needs_review", "running", "pending"]);

function HomeIcon({ name, size = 15 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function buildSevenDayTrend(runs: RunSummary[], nowMs = Date.now(), locale = "en"): TrendDay[] {
  const intlLocale = locale === "tl" ? "fil-PH" : "en-US";
  const today = new Date(nowMs);
  const buckets = new Map<string, TrendDay>();
  const days: TrendDay[] = [];

  for (let offset = 6; offset >= 0; offset--) {
    const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const key = localDayKey(dt);
    const shortLabel = dt.toLocaleDateString(intlLocale, { weekday: "narrow" }).slice(0, 1).toUpperCase();
    const dayName = dt.toLocaleDateString(intlLocale, { weekday: "long" });
    const entry: TrendDay = { key, shortLabel, dayName, total: 0, ok: 0, failed: 0, waiting: 0 };
    buckets.set(key, entry);
    days.push(entry);
  }

  for (const r of runs) {
    const dt = new Date(r.createdAt);
    if (Number.isNaN(dt.getTime())) continue;
    const bucket = buckets.get(localDayKey(dt));
    if (!bucket) continue;
    bucket.total += 1;
    if (r.state === "failed" || r.deliveryFailed) bucket.failed += 1;
    else if (r.needsReview || WAITING_STATES.has(r.state)) bucket.waiting += 1;
    else bucket.ok += 1;
  }

  return days;
}

export function computeHealthSummary(runs: RunSummary[], problemCount = 0): HealthSummary {
  const cutoff = Date.now() - 7 * 86_400_000;
  const inWindow = runs.filter((r) => {
    const ts = Date.parse(r.createdAt);
    return Number.isNaN(ts) || ts >= cutoff;
  });
  let ok = 0;
  let waiting = 0;
  let failed = 0;
  for (const r of inWindow) {
    if (r.state === "failed" || r.deliveryFailed) failed += 1;
    else if (r.needsReview || WAITING_STATES.has(r.state)) waiting += 1;
    else ok += 1;
  }
  const total = ok + waiting + failed;
  const pct = total > 0 ? Math.round((ok / total) * 100) : problemCount > 0 ? 0 : 100;
  return { total, ok, waiting, failed, pct };
}

/** #/ (G5): Today overview with Console Blocks KPIs, 7-day SVG chart, Health Donut, Connected apps, and Activity table. */
export function HomePage({
  user,
  initialData,
  initialConnections,
}: {
  user: User;
  initialData?: HomePayload;
  initialConnections?: HomeConnection[];
}) {
  const { t, language } = useLanguage();
  const owner = user.role === "owner";
  const staff = owner || user.role === "operator";
  const canAsk = user.ask === true && staff;
  const chartGradId = useId();

  const [data, setData] = useState<HomePayload | null>(initialData ?? null);
  const [runs7d, setRuns7d] = useState<RunSummary[] | null>(initialData?.recentRuns ?? null);
  const [connections, setConnections] = useState<HomeConnection[]>(initialConnections ?? []);
  const [query, setQuery] = useState("");
  const [filteredRuns, setFilteredRuns] = useState<RunSummary[] | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [error, setError] = useState("");
  const [activeDay, setActiveDay] = useState(6);
  const [tipOpen, setTipOpen] = useState(false);

  const load = async () => {
    try {
      const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Manila");
      const [homePayload, recentAll, connRes] = await Promise.all([
        api<HomePayload>("GET", `/home?tz=${tz}`),
        staff ? api<RunSummary[]>("GET", "/runs?limit=200").catch(() => null) : Promise.resolve(null),
        owner ? api<{ connections: HomeConnection[] }>("GET", "/settings/connections").catch(() => null) : Promise.resolve(null),
      ]);
      setData(homePayload);
      setRuns7d(recentAll ?? homePayload.recentRuns);
      if (connRes?.connections) setConnections(connRes.connections);
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
  }, [initialData, owner, staff]);

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

  const trend = useMemo(
    () => buildSevenDayTrend(runs7d ?? data?.recentRuns ?? [], Date.now(), language),
    [runs7d, data?.recentRuns, language],
  );
  const health = useMemo(
    () => computeHealthSummary(runs7d ?? data?.recentRuns ?? [], data?.problems.length ?? 0),
    [runs7d, data?.recentRuns, data?.problems.length],
  );

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
  const shownRuns = (trimmedQuery ? (filteredRuns ?? localMatches) : recent).slice(0, trimmedQuery ? 12 : 6);
  const runsTodayCount = data
    ? Math.max(
        (data.running ?? []).reduce((sum, w) => sum + w.runsToday, 0),
        trend[6]?.total ?? 0,
      )
    : 0;
  const total7dRuns = trend.reduce((sum, d) => sum + d.total, 0);
  const automationsHref = owner ? "#/automations" : "#/activity";
  const problemsHref = owner ? "#/automations" : "#/inbox";
  const safeActiveDay = Math.min(Math.max(activeDay, 0), trend.length - 1);
  const activeDayEntry = trend[safeActiveDay] ?? trend[6]!;
  const activeRate = activeDayEntry.total > 0 ? Math.round((activeDayEntry.ok / activeDayEntry.total) * 100) : 100;

  // Compute SVG area path over a 560x118 coordinate box.
  const chartW = 560;
  const chartH = 118;
  const padX = 16;
  const padY = 14;
  const maxVal = Math.max(4, ...trend.map((d) => d.total)) * 1.15;
  const pts = trend.map((d, i) => ({
    x: Number((padX + ((chartW - padX * 2) / 6) * i).toFixed(1)),
    y: Number((padY + (chartH - padY * 2) * (1 - d.total / maxVal)).toFixed(1)),
  }));
  let areaLine = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length; i++) {
    const cx = Number(((pts[i - 1]!.x + pts[i]!.x) / 2).toFixed(1));
    areaLine += ` C ${cx} ${pts[i - 1]!.y}, ${cx} ${pts[i]!.y}, ${pts[i]!.x} ${pts[i]!.y}`;
  }
  const areaFill = `${areaLine} L ${pts[6]!.x} ${chartH - padY} L ${pts[0]!.x} ${chartH - padY} Z`;
  const activePt = pts[safeActiveDay]!;
  const tipLeft = Math.min(82, Math.max(18, Number(((activePt.x / chartW) * 100).toFixed(1))));

  // Compute Health Donut segments (circumference = 2 * pi * 54 = 339.29).
  const C = 339.29;
  const okLen = health.total > 0 ? (health.ok / health.total) * C : (data?.problems.length ?? 0) === 0 ? C : 0;
  const waitLen = health.total > 0 ? (health.waiting / health.total) * C : 0;
  const failLen = health.total > 0 ? Math.max(0, C - okLen - waitLen) : (data?.problems.length ?? 0) > 0 ? C : 0;

  // Connected apps list (real error/active apps first, then up to 4 quick-connect options).
  const sortedApps = [...connections]
    .filter((c) => c.provider in APP_NAMES)
    .sort((a, b) => {
      const rank = (s: string) => (s === "error" ? 0 : s === "active" ? 1 : 2);
      return rank(a.status) - rank(b.status);
    });
  const seenProviders = new Set<string>();
  const appRows: Array<{ provider: string; status: "connected" | "error" | "idle" }> = [];
  for (const c of sortedApps) {
    if (c.status !== "active" && c.status !== "error") continue;
    if (seenProviders.has(c.provider)) continue;
    seenProviders.add(c.provider);
    appRows.push({ provider: c.provider, status: c.status === "error" ? "error" : "connected" });
    if (appRows.length >= 4) break;
  }
  if (appRows.length < 4) {
    for (const provider of QUICK_CONNECT_ORDER) {
      if (seenProviders.has(provider)) continue;
      seenProviders.add(provider);
      appRows.push({ provider, status: "idle" });
      if (appRows.length >= 4) break;
    }
  }

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
                  <span className="tnum">{t("{count} ran today", { count: runsTodayCount })}</span>
                  <span aria-hidden="true">→</span>
                </a>
              </article>

              <article className="hm-kpi-card motion-stagger-row" style={{ "--i": 1 } as CSSProperties}>
                <div className="hm-kpi-top">
                  <div className="hm-kpi-meta">
                    <span className="hm-kpi-label">{t("Runs today")}</span>
                    <div className="hm-kpi-val">
                      <strong className="tnum">{runsTodayCount}</strong>
                      <span className="pill neutral tnum">{t("{count} in 7d", { count: total7dRuns })}</span>
                    </div>
                  </div>
                  <span className="hm-kpi-ico"><HomeIcon name="activity" size={15} /></span>
                </div>
                <a className="hm-kpi-foot" href={automationsHref}>
                  <span>{t("Last 7 days activity")}</span>
                  <span aria-hidden="true">→</span>
                </a>
              </article>

              <article className="hm-kpi-card motion-stagger-row" style={{ "--i": 2 } as CSSProperties}>
                <div className="hm-kpi-top">
                  <div className="hm-kpi-meta">
                    <h2 className="hm-kpi-label">{t("Needs you")}</h2>
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
                  <span>{data.needsYou.total > 0 ? t("{count} waiting on staff", { count: data.needsYou.total }) : t("All caught up")}</span>
                  <span aria-hidden="true">→</span>
                </a>
              </article>

              <article className="hm-kpi-card motion-stagger-row" style={{ "--i": 3 } as CSSProperties}>
                <div className="hm-kpi-top">
                  <div className="hm-kpi-meta">
                    <span className="hm-kpi-label">{t("Success, 7 days")}</span>
                    <div className="hm-kpi-val">
                      <strong className={`tnum ${data.problems.length === 0 ? "ok" : "bad"}`}>{health.pct}%</strong>
                      <span className={`pill ${data.problems.length > 0 ? "bad" : "ok"}`}>
                        {data.problems.length > 0
                          ? t(data.problems.length === 1 ? "{count} Problem" : "{count} Problems", { count: data.problems.length })
                          : t("All clear")}
                      </span>
                    </div>
                  </div>
                  <span className="hm-kpi-ico"><HomeIcon name="checkCircle" size={15} /></span>
                </div>
                <a className="hm-kpi-foot" href={problemsHref}>
                  <span className="tnum">
                    {health.total > 0
                      ? t("{ok} succeeded · {failed} failed", { ok: health.ok, failed: health.failed })
                      : t("No problems right now")}
                  </span>
                  <span aria-hidden="true">→</span>
                </a>
              </article>
            </div>

            <div className="hm-bento-mid">
              <section className="act-card hm-card motion-stagger-row" style={{ "--i": 4 } as CSSProperties} aria-labelledby="home-ran-h">
                <div className="hm-card-head">
                  <span className="card-ico"><HomeIcon name="activity" size={14} /></span>
                  <h2 id="home-ran-h">{t("What ran")}</h2>
                  <span className="hm-trend-tip">
                    <strong>{activeDayEntry.dayName}</strong>
                    <span className="tnum act-muted">{t("{count} runs", { count: activeDayEntry.total })}</span>
                  </span>
                  {owner && <a className="card-link" href="#/automations">{t("All automations")}</a>}
                </div>

                <div className="hm-chart-box">
                  <div className="hm-chart-stage" onMouseLeave={() => setTipOpen(false)}>
                    <svg className="hm-area-svg" viewBox={`0 0 ${chartW} ${chartH}`} preserveAspectRatio="none" role="img" aria-label={t("Last 7 days activity")}>
                      <defs>
                        <linearGradient id={chartGradId} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.20" />
                          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.01" />
                        </linearGradient>
                      </defs>
                      <line x1={padX} x2={chartW - padX} y1={14} y2={14} className="hm-gridline" />
                      <line x1={padX} x2={chartW - padX} y1={48} y2={48} className="hm-gridline" />
                      <line x1={padX} x2={chartW - padX} y1={82} y2={82} className="hm-gridline" />
                      <path d={areaFill} fill={`url(#${chartGradId})`} />
                      <path d={areaLine} className="hm-area-line" />
                      <line x1={activePt.x} x2={activePt.x} y1={activePt.y} y2={chartH - padY} className="hm-focus-stem" />
                      <circle cx={activePt.x} cy={activePt.y} r="9" className="hm-focus-halo" />
                      <circle cx={activePt.x} cy={activePt.y} r="4.5" className="hm-focus-dot" />
                      {pts.map((pt, i) => {
                        const left = i === 0 ? 0 : (pts[i - 1]!.x + pt.x) / 2;
                        const right = i === pts.length - 1 ? chartW : (pt.x + pts[i + 1]!.x) / 2;
                        return (
                          <rect
                            key={trend[i]!.key}
                            className="hm-chart-hit"
                            x={left.toFixed(1)}
                            y="0"
                            width={(right - left).toFixed(1)}
                            height={chartH}
                            onMouseEnter={() => {
                              setActiveDay(i);
                              setTipOpen(true);
                            }}
                          />
                        );
                      })}
                    </svg>
                    <div className="hm-chart-tip" data-open={tipOpen ? "true" : "false"} style={{ left: `${tipLeft}%` }}>
                      <div className="hm-chart-tip-head">
                        <strong>{activeDayEntry.dayName}</strong>
                        <span className="tnum">{t("{count} runs", { count: activeDayEntry.total })}</span>
                      </div>
                      <div className="hm-chart-tip-sub">
                        <span className="tnum">{t("{ok} ok · {failed} failed", { ok: activeDayEntry.ok, failed: activeDayEntry.failed })}</span>
                        <span className="tnum hm-tip-rate">{activeRate}%</span>
                      </div>
                    </div>
                  </div>
                  <div className="hm-day-row">
                    {trend.map((d, i) => (
                      <button
                        key={d.key}
                        type="button"
                        className="hm-day-btn"
                        aria-label={d.dayName}
                        aria-pressed={i === safeActiveDay}
                        onClick={() => setActiveDay(i)}
                      >
                        {d.shortLabel}
                      </button>
                    ))}
                  </div>
                </div>

                {data.running.length === 0 ? (
                  <p className="hm-running-empty act-muted">
                    {t("No automations are turned on yet.")}{" "}
                    {owner && <a href="#/new">{t("Turn one on")}</a>}
                  </p>
                ) : (
                  <div className="hm-running-strip" aria-label={t("Running automations")}>
                    {data.running.map((w) => (
                      <a key={w.id} className="hm-running-chip" href={`#/a/${w.id}`}>
                        <strong>{w.name}</strong>
                        <span className="tnum">{w.runsToday}</span>
                      </a>
                    ))}
                  </div>
                )}
              </section>

              <section className="act-card hm-card motion-stagger-row" style={{ "--i": 5 } as CSSProperties} aria-labelledby="home-problems-h">
                <div className="hm-card-head">
                  <span className="card-ico"><HomeIcon name="alert" size={14} /></span>
                  <h2 id="home-problems-h">{t("Problems")}</h2>
                  <span className={`pill ${data.problems.length > 0 ? "bad" : "ok"} hm-head-pill tnum`}>{data.problems.length}</span>
                </div>

                <div className="hm-donut-wrap">
                  <svg width="114" height="114" viewBox="0 0 140 140" role="img" aria-label={`${t("Health")}: ${health.pct}%`}>
                    <circle cx="70" cy="70" r="54" fill="none" stroke="var(--border-soft)" strokeWidth="14" />
                    {okLen > 0 && (
                      <circle
                        cx="70"
                        cy="70"
                        r="54"
                        fill="none"
                        stroke="var(--ok)"
                        strokeWidth="14"
                        strokeLinecap="round"
                        strokeDasharray={`${okLen.toFixed(1)} ${C.toFixed(1)}`}
                        transform="rotate(-90 70 70)"
                      />
                    )}
                    {waitLen > 0 && (
                      <circle
                        cx="70"
                        cy="70"
                        r="54"
                        fill="none"
                        stroke="var(--warn-dot)"
                        strokeWidth="14"
                        strokeLinecap="round"
                        strokeDasharray={`${waitLen.toFixed(1)} ${C.toFixed(1)}`}
                        strokeDashoffset={(-okLen).toFixed(1)}
                        transform="rotate(-90 70 70)"
                      />
                    )}
                    {failLen > 0 && (
                      <circle
                        cx="70"
                        cy="70"
                        r="54"
                        fill="none"
                        stroke="var(--bad)"
                        strokeWidth="14"
                        strokeLinecap="round"
                        strokeDasharray={`${failLen.toFixed(1)} ${C.toFixed(1)}`}
                        strokeDashoffset={(-(okLen + waitLen)).toFixed(1)}
                        transform="rotate(-90 70 70)"
                      />
                    )}
                    <text x="70" y="68" textAnchor="middle" fill="var(--text)" fontSize="24" fontWeight="600">{health.pct}%</text>
                    <text x="70" y="86" textAnchor="middle" fill="var(--muted)" fontSize="13" fontWeight="500">{t("Health")}</text>
                  </svg>
                  <div className="hm-donut-legend">
                    <span><i style={{ background: "var(--ok)" }} /> {t("Succeeded")}</span>
                    <span><i style={{ background: "var(--warn-dot)" }} /> {t("Waiting")}</span>
                    <span><i style={{ background: "var(--bad)" }} /> {t("Failed")}</span>
                  </div>
                </div>

                {data.problems.length === 0 ? (
                  <div className="hm-healthy">
                    <span className="pill ok"><i className="dot" aria-hidden="true" />{t("All clear")}</span>
                    <p className="act-muted">{t("No problems right now")}</p>
                  </div>
                ) : (
                  <ul className="hm-list">
                    {data.problems.slice(0, 2).map((p) => (
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

            <div className={owner ? "hm-bento-bot" : "hm-bento-single"}>
              {owner && (
                <section className="act-card hm-card motion-stagger-row" style={{ "--i": 6 } as CSSProperties} aria-labelledby="home-apps-h">
                  <div className="hm-card-head">
                    <span className="card-ico"><HomeIcon name="link" size={14} /></span>
                    <h3 id="home-apps-h">{t("Connected apps")}</h3>
                    <a className="card-link" href="#/apps">{t("Manage")}</a>
                  </div>
                  <ul className="hm-apps-list">
                    {appRows.map((row) => {
                      const appName = APP_NAMES[row.provider] ?? row.provider;
                      const mark = APP_LOGO[row.provider] ?? row.provider;
                      return (
                        <li key={row.provider}>
                          <a className="hm-app-row" href={`#/business?tab=apps&app=${row.provider}`}>
                            <AppMark mark={mark} name={appName} size={26} decorative />
                            <span className="hm-app-name">{t(appName)}</span>
                            <span className={`pill ${row.status === "connected" ? "ok" : row.status === "error" ? "bad" : "neutral"}`}>
                              {t(row.status === "connected" ? "Connected" : row.status === "error" ? "Error" : "Not connected")}
                            </span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <section className="act-card hm-card motion-stagger-row" style={{ "--i": 7 } as CSSProperties} aria-labelledby="home-activity-h">
                <div className="hm-card-head">
                  <span className="card-ico"><HomeIcon name="fileText" size={14} /></span>
                  <h3 id="home-activity-h">{t("Recent activity")}</h3>
                  <div className="hm-activity-tools">
                    <input
                      type="search"
                      aria-label={t("Search recent runs")}
                      placeholder={t("Search reference or automation")}
                      value={query}
                      maxLength={100}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {canAsk && (
                      <button
                        type="button"
                        className="act-button hm-ask-btn"
                        aria-label={askOpen ? t("Hide question helper") : t("Ask about a request")}
                        aria-expanded={askOpen}
                        onClick={() => setAskOpen((was) => !was)}
                      >
                        {askOpen ? t("Hide") : t("Ask")}
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
            </div>
          </>
        )}
      </div>
    </main>
  );
}
