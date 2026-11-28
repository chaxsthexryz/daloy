import "./workspace.css";
import "./admin.css";
import { useEffect, useState, type ReactNode } from "react";
import { AdminAiTab } from "./AdminAi";
import { AdminFeedbackTab } from "./AdminFeedback";
import { AdminSignIn, EnrollTwoFactor, TwoFactorStatus, VerifyTwoFactor } from "./AdminTwoFactor";
import { api, ApiError } from "./api";
import { LanguageContext, useLanguage } from "./Language";
import { shortDate, shortDateTime } from "./lib/advanced";
import { ADMIN_TABS, adminRoute, tabHref, type AdminTab } from "./lib/admin-route";
import type { Language } from "./lib/locale";

type Counts = { total: number; new7: number; new30: number };
export type WorkspaceRow = { id: string; email: string; createdAt: string; plan: string | null; planStartedOn: string | null; sharedMailDailyLimit: number | null; aiThinking?: string | null; members: number; runs30: number; failed: number; needsReview: number; ai: number; sms: number };
type Action = { id: string; adminEmail: string; action: string; workspaceEmail: string | null; before: Record<string, unknown>; after: Record<string, unknown>; createdAt: string };
export type Overview = {
  users: Counts;
  workspaces: Counts & { rows: WorkspaceRow[] };
  runs30: Record<string, number>;
  attention: { runsFailed: number; runsNeedsReview: number; deliveriesFailed: number; deliveriesNeedsReview: number };
  usage: { ai: number; sms: number };
  actions: Action[];
};
type AdminRun = { id: string; email: string; workflow: string; version: number; state: string; test: boolean; live: boolean; createdAt: string; finishedAt: string | null; hasError: boolean; steps: Record<string, number> };

const PLANS = ["preview", "pilot", "business", "business_plus", "concierge"];
const STATES = ["pending", "running", "waiting", "needs_review", "succeeded", "failed", "cancelled"];
const TAB_LABELS: Record<AdminTab, string> = { overview: "Overview", workspaces: "Workspaces", runs: "Runs", ai: "AI models", feedback: "Feedback", audit: "Audit log" };
const TAB_LEADS: Record<AdminTab, string> = {
  overview: "Counts across every workspace. This console never shows run data, step data, error text or secrets.",
  workspaces: "Newest first. A change is saved for that workspace and recorded in the audit log.",
  runs: "The latest runs across every workspace: state and step counts only.",
  ai: "The shared model every workspace on a plan uses unless it brings its own key. Changes apply to the next AI step.",
  feedback: "Messages workspaces send from Support. A reply is emailed to the sender.",
  audit: "Every change made here, newest first. Entries cannot be edited or deleted.",
};
const ACTIONS: Record<string, string> = {
  plan: "changed the plan of",
  shared_mail: "changed shared mail for",
  ai: "changed the shared AI model",
  ai_thinking: "changed AI thinking for",
  feedback_reply: "replied to feedback from",
  feedback_close: "closed feedback from",
  "2fa_enroll": "turned on two-factor sign-in",
  "2fa_failed": "entered a wrong two-factor code",
  "2fa_recovery": "signed in with a recovery code",
  "2fa_reset": "reset two-factor sign-in",
};
const tone = (state: string) => (state === "succeeded" ? "ok" : state === "failed" ? "bad" : state === "needs_review" || state === "waiting" ? "warn" : "neutral");
// Ids say nothing to a reader of the log; the workspace is already named.
const show = (v: Record<string, unknown>) => Object.entries(v).filter(([k]) => !k.endsWith("Id")).map(([, x]) => (x === null ? "none" : String(x))).join(", ");

/** The tabs this build shows. A tab whose API has not shipped stays out of the navigation (decision 0152). */
export const SHOWN_TABS: readonly AdminTab[] = ADMIN_TABS;

/**
 * The navigation and page frame of the admin console. It has no workspace sidebar: the admin console is its own app at
 * /admin, and the workspace console does not link to it.
 */
export function AdminShell({ tab, email, consoleUrl = "/", tabs = SHOWN_TABS, badges = {}, onSignOut, twoFactor, children }: { tab: AdminTab; email: string; consoleUrl?: string; tabs?: readonly AdminTab[]; badges?: Partial<Record<AdminTab, number>>; onSignOut: () => void; twoFactor?: ReactNode; children: ReactNode }) {
  const { t } = useLanguage();
  return (
    <div className="wk ad-shell">
      <nav className="ad-nav" aria-label={t("Platform admin")}>
        <div className="ad-brand">
          <img src="/logo.svg" alt="" width={20} height={20} />
          <span>kymavo</span>
          <span className="wk-chip">{t("Admin")}</span>
        </div>
        <ul className="ad-links">
          {tabs.map((k) => (
            <li key={k}>
              <a className="ad-link" href={tabHref(k)} aria-current={k === tab ? "page" : undefined}>
                <span>{t(TAB_LABELS[k])}</span>
                {badges[k] ? <span className="ad-badge" aria-label={t("{count} new", { count: badges[k] })}>{badges[k]}</span> : null}
              </a>
            </li>
          ))}
        </ul>
        <div className="ad-foot">
          <span className="ad-who">{t("Signed in as {email}", { email })}</span>
          <a href={consoleUrl}>{t("Open the workspace console")}</a>
          {twoFactor}
          <button type="button" className="wk-button" onClick={onSignOut}>{t("Sign out")}</button>
        </div>
      </nav>
      <main className="ad-main" id="admin-main">
        <header className="wk-head">
          <div>
            <h1>{t(TAB_LABELS[tab])}</h1>
            <p className="wk-sub">{t(TAB_LEADS[tab])}</p>
          </div>
        </header>
        <div className="ad-body motion-page">{children}</div>
      </main>
    </div>
  );
}

type Gate = "loading" | "signin" | "setup" | "verify" | "ready" | "missing";

/**
 * The admin console app, mounted by admin-main.tsx at /admin, or at / on ADMIN_HOST (decision 0157). The API answers
 * 404 to anyone outside PLATFORM_ADMINS. Before the console the admin signs in (on its own host), then sets up or
 * enters two-factor sign-in (decision 0158).
 */
export function AdminApp() {
  const [language, setLanguage] = useState<Language>("en");
  const [email, setEmail] = useState("");
  const [consoleUrl, setConsoleUrl] = useState("/");
  const [gate, setGate] = useState<Gate>("loading");
  const [hash, setHash] = useState(location.hash);
  const [data, setData] = useState<Overview | null>(null);
  const [newFeedback, setNewFeedback] = useState(0);
  const [error, setError] = useState("");
  /** Where this session stands: signed in, an admin, and through two-factor. A 403 later sends it back here. */
  const check = async () => {
    try {
      const me = await api<{ email: string; language?: string }>("GET", "/auth/me");
      setEmail(me.email);
      setLanguage(me.language === "tl" ? "tl" : "en");
      const tf = await api<{ enrolled: boolean; verified: boolean; consoleUrl: string }>("GET", "/admin/2fa");
      // Served at / only on the admin host, where / is this console: the workspace console is on the main host.
      if (location.pathname === "/") setConsoleUrl(`${tf.consoleUrl}/`);
      setGate(!tf.enrolled ? "setup" : !tf.verified ? "verify" : "ready");
    } catch (e) {
      setGate(e instanceof ApiError && e.status === 401 ? "signin" : "missing");
    }
  };
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return setGate("missing");
    setError((e as Error).message);
    // A 403 is usually an expired two-factor check: check() opens the code prompt then.
    if (e instanceof ApiError && e.status === 403) void check();
  };
  const load = () => api<Overview>("GET", "/admin/overview").then(setData, fail);
  const countFeedback = () => {
    if (SHOWN_TABS.includes("feedback")) api<{ items: unknown[] }>("GET", "/admin/feedback?status=new").then((r) => setNewFeedback(r.items.length), () => undefined);
  };
  useEffect(() => {
    void check();
    const onHash = () => setHash(location.hash);
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (gate !== "ready") return;
    setError("");
    void load();
    countFeedback();
  }, [gate]);
  const { tab, params } = adminRoute(hash, SHOWN_TABS);
  useEffect(() => {
    document.title = `${TAB_LABELS[tab]} · kymavo admin`;
  }, [tab]);
  // On the admin host sign-out stays there, on its sign-in; at /admin it goes back to the workspace console.
  const signOut = () => void api("POST", "/auth/logout").finally(() => (location.pathname === "/" ? location.reload() : location.assign("/")));

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {gate === "loading" ? (
        <main className="page wk ad-gate"><Loading /></main>
      ) : gate === "missing" ? (
        <NotFound />
      ) : gate === "signin" ? (
        <AdminSignIn onSignedIn={() => void check()} />
      ) : gate === "setup" ? (
        <EnrollTwoFactor onDone={() => setGate("ready")} onSignOut={signOut} />
      ) : gate === "verify" ? (
        <VerifyTwoFactor onDone={() => setGate("ready")} onSignOut={signOut} />
      ) : (
        <AdminShell tab={tab} email={email} consoleUrl={consoleUrl} badges={{ feedback: newFeedback }} onSignOut={signOut} twoFactor={<TwoFactorStatus onReset={() => setGate("setup")} />}>
          <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
          {tab === "runs" ? (
            <RunsTab state={params.get("state") ?? ""} onError={fail} />
          ) : tab === "feedback" ? (
            <AdminFeedbackTab status={params.get("status") ?? ""} onChanged={() => { countFeedback(); void load(); }} onError={fail} />
          ) : data === null ? (
            <Loading />
          ) : tab === "workspaces" ? (
            <WorkspacesTab data={data} onSaved={() => void load()} onError={setError} />
          ) : tab === "ai" ? (
            <AdminAiTab rows={data.workspaces.rows} onSaved={() => void load()} onError={fail} />
          ) : tab === "audit" ? (
            <AuditTab actions={data.actions} />
          ) : (
            <OverviewTab data={data} newFeedback={newFeedback} />
          )}
        </AdminShell>
      )}
    </LanguageContext.Provider>
  );
}

function NotFound() {
  const { t } = useLanguage();
  return <main className="page wk"><p className="wk-lead" role="status">{t("This page does not exist.")}</p></main>;
}

export function Loading() {
  const { t } = useLanguage();
  return <p className="wk-sub" role="status">{t("Loading…")}</p>;
}

/** A count that opens the tab with the detail behind it. */
function Tile({ label, value, note, href }: { label: string; value: number; note?: string; href?: string }) {
  const body = (
    <>
      <span className="wk-sub">{label}</span>
      <b>{value}</b>
      {note && <span className="wk-muted">{note}</span>}
    </>
  );
  return href ? <a className="ad-tile" href={href}>{body}</a> : <div className="ad-tile">{body}</div>;
}

export function OverviewTab({ data, newFeedback = 0 }: { data: Overview; newFeedback?: number }) {
  const { t } = useLanguage();
  const runs30 = Object.values(data.runs30).reduce((a, b) => a + b, 0);
  const growth = (c: Counts) => t("{week} new this week, {month} in 30 days", { week: c.new7, month: c.new30 });
  return (
    <>
      <section className="ad-tiles" aria-label={t("Totals")}>
        <Tile label={t("Users")} value={data.users.total} note={growth(data.users)} href={tabHref("workspaces")} />
        <Tile label={t("Workspaces")} value={data.workspaces.total} note={growth(data.workspaces)} href={tabHref("workspaces")} />
        <Tile label={t("Runs in 30 days")} value={runs30} href={tabHref("runs")} />
        <Tile label={t("Failed runs")} value={data.attention.runsFailed} href={tabHref("runs", { state: "failed" })} />
        <Tile label={t("Runs to review")} value={data.attention.runsNeedsReview} href={tabHref("runs", { state: "needs_review" })} />
        <Tile label={t("Failed deliveries")} value={data.attention.deliveriesFailed} />
        <Tile label={t("Deliveries to review")} value={data.attention.deliveriesNeedsReview} />
        <Tile label={t("AI actions this cycle")} value={data.usage.ai} href={SHOWN_TABS.includes("ai") ? tabHref("ai") : undefined} />
        <Tile label={t("SMS this cycle")} value={data.usage.sms} href={tabHref("workspaces")} />
        {SHOWN_TABS.includes("feedback") && <Tile label={t("New feedback")} value={newFeedback} href={tabHref("feedback", { status: "new" })} />}
        <Tile label={t("Changes by admins")} value={data.actions.length} note={t("The latest 50")} href={tabHref("audit")} />
      </section>
      <section className="wk-card" aria-label={t("Runs in 30 days by state")}>
        <h2 className="wk-card-head"><b>{t("Runs in 30 days by state")}</b></h2>
        <div className="wk-body">
          <ul className="wk-usage ad-states">
            {STATES.map((s) => (
              <li key={s}>
                <a href={tabHref("runs", { state: s })}>{s}</a>
                <span className="ad-num">{data.runs30[s] ?? 0}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}

function WorkspacesTab({ data, onSaved, onError }: { data: Overview; onSaved: () => void; onError: (m: string) => void }) {
  const { t } = useLanguage();
  const [q, setQ] = useState("");
  const rows = data.workspaces.rows.filter((w) => w.email.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <section className="wk-card" aria-label={t("Workspaces")}>
      <div className="wk-card-head ad-toolbar">
        <b>{t("{count} workspaces", { count: rows.length })}</b>
        <input type="search" className="ad-search" aria-label={t("Filter by owner email")} placeholder={t("Filter by owner email")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="ad-scroll">
        <table className="wk-table">
          <thead>
            <tr>
              <th scope="col">{t("Owner")}</th>
              <th scope="col">{t("Created")}</th>
              <th scope="col">{t("Members")}</th>
              <th scope="col">{t("Runs in 30 days")}</th>
              <th scope="col">{t("Failed")}</th>
              <th scope="col">{t("To review")}</th>
              <th scope="col">AI</th>
              <th scope="col">SMS</th>
              <th scope="col">{t("Plan")}</th>
              <th scope="col">{t("Shared mail a day")}</th>
              <th scope="col"><span className="wk-sr">{t("Save")}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => <WorkspaceLine key={`${w.id}:${w.plan}:${w.sharedMailDailyLimit}`} row={w} onSaved={onSaved} onError={onError} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WorkspaceLine({ row, onSaved, onError }: { row: WorkspaceRow; onSaved: () => void; onError: (m: string) => void }) {
  const { t } = useLanguage();
  const [plan, setPlan] = useState(row.plan ?? "");
  const [limit, setLimit] = useState(row.sharedMailDailyLimit === null ? "" : String(row.sharedMailDailyLimit));
  const [busy, setBusy] = useState(false);
  const planChanged = plan !== (row.plan ?? "");
  const limitChanged = limit !== (row.sharedMailDailyLimit === null ? "" : String(row.sharedMailDailyLimit));
  const save = async () => {
    setBusy(true);
    onError("");
    try {
      if (planChanged) await api("PUT", `/admin/workspaces/${row.id}/plan`, { plan: plan || null });
      if (limitChanged) await api("PUT", `/admin/workspaces/${row.id}/shared-mail`, { dailyLimit: limit === "" ? null : Number(limit) });
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <tr>
      <td className="wk-name">{row.email}</td>
      <td>{shortDate(row.createdAt)}</td>
      <td>{row.members}</td>
      <td>{row.runs30}</td>
      <td>{row.failed}</td>
      <td>{row.needsReview}</td>
      <td>{row.ai}</td>
      <td>{row.sms}</td>
      <td>
        <select aria-label={t("Plan for {email}", { email: row.email })} value={plan} onChange={(e) => setPlan(e.target.value)}>
          <option value="">{t("No plan")}</option>
          {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </td>
      <td>
        <input aria-label={t("Shared mail a day for {email}", { email: row.email })} type="number" min={1} max={10000} placeholder={t("Not approved")} value={limit} onChange={(e) => setLimit(e.target.value)} />
      </td>
      <td><button type="button" className="wk-button" disabled={busy || (!planChanged && !limitChanged)} onClick={() => void save()}>{t("Save")}</button></td>
    </tr>
  );
}

function RunsTab({ state, onError }: { state: string; onError: (e: unknown) => void }) {
  const { t } = useLanguage();
  const [runs, setRuns] = useState<AdminRun[] | null>(null);
  const valid = STATES.includes(state) ? state : "";
  useEffect(() => {
    setRuns(null);
    api<AdminRun[]>("GET", `/admin/runs${valid ? `?state=${valid}` : ""}`).then(setRuns, onError);
  }, [valid]);
  return (
    <section className="wk-card" aria-label={t("Recent runs")}>
      <div className="wk-card-head ad-toolbar">
        <b>{t("Recent runs")}</b>
        <label className="ad-filter">
          {t("State")}{" "}
          <select value={valid} onChange={(e) => location.assign(tabHref("runs", e.target.value ? { state: e.target.value } : undefined))}>
            <option value="">{t("All states")}</option>
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      {runs === null ? (
        <p className="wk-body wk-sub" role="status">{t("Loading…")}</p>
      ) : runs.length === 0 ? (
        <p className="wk-body wk-sub">{t("None yet.")}</p>
      ) : (
        <div className="ad-scroll">
          <table className="wk-table">
            <thead>
              <tr>
                <th scope="col">{t("Owner")}</th>
                <th scope="col">{t("Automation")}</th>
                <th scope="col">{t("State")}</th>
                <th scope="col">{t("Kind")}</th>
                <th scope="col">{t("Started")}</th>
                <th scope="col">{t("Finished")}</th>
                <th scope="col">{t("Steps")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{r.email}</td>
                  <td>{r.workflow} <span className="wk-muted">v{r.version}</span></td>
                  <td><span className={`pill ${tone(r.state)}`}>{r.state}</span>{r.hasError && <span className="wk-muted"> ({t("has an error")})</span>}</td>
                  <td>{r.test ? (r.live ? t("Live test") : t("Test")) : t("Live")}</td>
                  <td>{shortDateTime(r.createdAt)}</td>
                  <td>{r.finishedAt ? shortDateTime(r.finishedAt) : ""}</td>
                  <td>{Object.entries(r.steps).map(([s, n]) => `${s} ${n}`).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AuditTab({ actions }: { actions: Action[] }) {
  const { t } = useLanguage();
  return (
    <section className="wk-card" aria-label={t("Changes by admins")}>
      <h2 className="wk-card-head"><b>{t("Changes by admins")}</b><span>{t("The latest 50. They cannot be edited or deleted.")}</span></h2>
      {actions.length === 0 ? (
        <p className="wk-body wk-sub">{t("None yet.")}</p>
      ) : (
        <ul className="wk-body ad-log">
          {actions.map((a) => (
            <li key={a.id}>
              <span className="wk-muted">{shortDateTime(a.createdAt)}</span>{" "}
              {a.adminEmail} {t(ACTIONS[a.action] ?? a.action)}
              {/* Two-factor entries are about the admin, not a workspace, and carry no values worth showing. */}
              {a.action.startsWith("2fa_") ? null : <>{a.action !== "ai" && <> {a.workspaceEmail ?? t("a deleted workspace")}</>}, {show(a.before) || t("none")} → {show(a.after)}</>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
