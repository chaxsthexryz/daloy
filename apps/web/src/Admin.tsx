import "./workspace.css";
import "./admin.css";
import { useEffect, useState } from "react";
import { Breadcrumb } from "./Breadcrumb";
import { api, ApiError } from "./api";
import { useLanguage } from "./Language";
import { shortDate, shortDateTime } from "./lib/advanced";

type Counts = { total: number; new7: number; new30: number };
type WorkspaceRow = { id: string; email: string; createdAt: string; plan: string | null; planStartedOn: string | null; sharedMailDailyLimit: number | null; members: number; runs30: number; failed: number; needsReview: number; ai: number; sms: number };
type Action = { id: string; adminEmail: string; action: "plan" | "shared_mail"; workspaceEmail: string | null; before: Record<string, unknown>; after: Record<string, unknown>; createdAt: string };
type Overview = {
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
const show = (v: Record<string, unknown>) => Object.values(v).map((x) => (x === null ? "none" : String(x))).join(", ");

/**
 * The platform Super-Admin page (A1, decision 0122), for accounts in PLATFORM_ADMINS. The API answers 404 to everyone
 * else, and so does this page. It shows counts and run metadata across workspaces, and changes plans and shared mail.
 */
export function AdminPage() {
  const { t } = useLanguage();
  const [data, setData] = useState<Overview | null>(null);
  const [runs, setRuns] = useState<AdminRun[] | null>(null);
  const [state, setState] = useState("");
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const fail = (e: unknown) => (e instanceof ApiError && e.status === 404 ? setMissing(true) : setError((e as Error).message));
  const load = () => api<Overview>("GET", "/admin/overview").then(setData, fail);
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    api<AdminRun[]>("GET", `/admin/runs${state ? `?state=${state}` : ""}`).then(setRuns, fail);
  }, [state]);

  if (missing) return <main className="page wk"><p className="wk-lead" role="status">{t("This page does not exist.")}</p></main>;
  const tile = (label: string, value: number, note?: string) => (
    <div className="ad-tile">
      <span className="wk-sub">{label}</span>
      <b>{value}</b>
      {note && <span className="wk-muted">{note}</span>}
    </div>
  );
  const runs30 = data ? Object.values(data.runs30).reduce((a, b) => a + b, 0) : 0;
  return (
    <main className="page wk ad">
      <header className="wk-head">
        <div>
          <Breadcrumb items={[{ label: t("Settings"), href: "#/settings" }, { label: t("Platform admin") }]} />
          <div className="wk-title-row"><h1>{t("Platform admin")}</h1></div>
        </div>
      </header>
      <p className="wk-lead wk-narrow-text">{t("This page reads across every workspace. It never shows run data, step data, error text or secrets.")}</p>
      <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
      {data === null ? (
        <p className="wk-sub" role="status">{t("Loading…")}</p>
      ) : (
        <>
          <section className="ad-tiles" aria-label={t("Totals")}>
            {tile(t("Users"), data.users.total, t("{week} new this week, {month} in 30 days", { week: data.users.new7, month: data.users.new30 }))}
            {tile(t("Workspaces"), data.workspaces.total, t("{week} new this week, {month} in 30 days", { week: data.workspaces.new7, month: data.workspaces.new30 }))}
            {tile(t("Runs in 30 days"), runs30)}
            {tile(t("Failed runs"), data.attention.runsFailed)}
            {tile(t("Runs to review"), data.attention.runsNeedsReview)}
            {tile(t("Failed deliveries"), data.attention.deliveriesFailed)}
            {tile(t("Deliveries to review"), data.attention.deliveriesNeedsReview)}
            {tile(t("AI actions this cycle"), data.usage.ai)}
            {tile(t("SMS this cycle"), data.usage.sms)}
          </section>

          <section className="wk-card" aria-label={t("Workspaces")}>
            <h2 className="wk-card-head"><b>{t("Workspaces")}</b><span>{t("Newest first. A change is saved for that workspace and recorded below.")}</span></h2>
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
                    <th scope="col"><span className="sr-only">{t("Save")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.workspaces.rows.map((w) => <WorkspaceLine key={`${w.id}:${w.plan}:${w.sharedMailDailyLimit}`} row={w} onSaved={() => void load()} onError={setError} />)}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section className="wk-card" aria-label={t("Recent runs")}>
        <h2 className="wk-card-head">
          <b>{t("Recent runs")}</b>
          <label className="ad-filter">
            {t("State")}{" "}
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">{t("All states")}</option>
              {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </h2>
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
                    <td>{r.state}{r.hasError && <span className="wk-muted"> ({t("has an error")})</span>}</td>
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

      {data && (
        <section className="wk-card" aria-label={t("Changes by admins")}>
          <h2 className="wk-card-head"><b>{t("Changes by admins")}</b><span>{t("The latest 50. They cannot be edited or deleted.")}</span></h2>
          {data.actions.length === 0 ? (
            <p className="wk-body wk-sub">{t("None yet.")}</p>
          ) : (
            <ul className="wk-body ad-log">
              {data.actions.map((a) => (
                <li key={a.id}>
                  {shortDateTime(a.createdAt)}: {a.adminEmail} {a.action === "plan" ? t("changed the plan of") : t("changed shared mail for")} {a.workspaceEmail ?? t("a deleted workspace")}, {show(a.before)} → {show(a.after)}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
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
