import { useEffect, useState } from "react";
import { getUsage, type Meter, type Usage } from "./api";
import { day } from "./lib/usage";
import { saveTheme, savedTheme, type Theme } from "./lib/theme";
import { Header } from "./Nav";
import type { Role, User } from "./Team";
import { UsageNotice } from "./UsageNotice";

const THEMES: [Theme, string][] = [
  ["system", "System (follows this device)"],
  ["light", "Light"],
  ["dark", "Dark"],
];
const ROLES: Record<Role, string> = { owner: "Owner", operator: "Operator", approver: "Approver", requester: "Requester" };

const ofLimit = (m: Meter) => (m.limit === null ? `${m.used}, no limit` : `${m.used} of ${m.limit}`);

/** Plan, what this workspace has used and when each count resets. Hidden when /usage cannot be read. */
function PlanAndUsage() {
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    getUsage().then(setU, () => undefined);
  }, []);
  if (!u) return null;
  const { automations: a } = u;
  return (
    <section aria-labelledby="plan-usage">
      <h2 id="plan-usage">Plan and usage</h2>
      <p>{u.plan ? `Plan: ${u.label ?? u.plan}` : "No plan limits are set. The operator sets the plan."}</p>
      <ul className="list">
        <li>
          AI actions: {ofLimit(u.ai)} this month <span className="muted">(back on {day(u.ai.resetsOn)})</span>
        </li>
        <li>
          Emails: {ofLimit(u.email)} today <span className="muted">(back on {day(u.email.resetsOn)})</span>
        </li>
        <li>
          Web requests: {ofLimit(u.http)} today <span className="muted">(back on {day(u.http.resetsOn)})</span>
        </li>
        <li>Live automations: {a.limit === null ? `${a.live}, no limit` : `${a.live} of ${a.limit}`}</li>
        {u.minScheduleMinutes !== null && <li>Shortest schedule: every {u.minScheduleMinutes} minutes</li>}
      </ul>
      <UsageNotice usage={u} />
      {u.plan && <p className="muted">To change your plan, message the Daloy operator. Payment is monthly by GCash or Maya.</p>}
    </section>
  );
}

/** #/settings: how the console looks on this device, the account, and (for owners) the office's settings in one list. */
export function SettingsPage({ user }: { user: User }) {
  const [theme, setTheme] = useState(savedTheme);
  const pick = (t: Theme) => {
    setTheme(t);
    saveTheme(t);
  };
  return (
    <main className="page narrow">
      <Header title="Settings" />
      <fieldset>
        <legend>Appearance</legend>
        {THEMES.map(([value, label]) => (
          <label key={value} className="check">
            <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => pick(value)} /> {label}
          </label>
        ))}
        <p className="muted">Saved on this device only.</p>
      </fieldset>
      <h2>Your account</h2>
      <p>
        Signed in as {user.email}, {ROLES[user.role]}.
      </p>
      {(user.role === "owner" || user.role === "operator") && <PlanAndUsage />}
      {user.role === "owner" && (
        <>
          <h2>Your office</h2>
          <ul className="list">
            <li>
              <a href="#/apps">Apps</a> <span className="muted">Gmail, Outlook, Google Sheets, Slack and Teams</span>
            </li>
            <li>
              <a href="#/settings/business">Business</a> <span className="muted">your business details and the website inquiry form</span>
            </li>
            <li>
              <a href="#/team">Team</a> <span className="muted">who can use Daloy and what each person may do</span>
            </li>
            <li>
              <a href="#/resources">Resources</a> <span className="muted">rooms, people and tables that bookings reserve</span>
            </li>
            <li>
              <a href="#/settings/ai">AI model</a> <span className="muted">which model drafts and classifies, and its key</span>
            </li>
            <li>
              <a href="#/tokens">API tokens</a> <span className="muted">for MCP clients and scripts</span>
            </li>
          </ul>
        </>
      )}
    </main>
  );
}
