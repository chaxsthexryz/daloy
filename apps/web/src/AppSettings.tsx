import { useState } from "react";
import { saveTheme, savedTheme, type Theme } from "./lib/theme";
import { Header } from "./Nav";
import type { Role, User } from "./Team";

const THEMES: [Theme, string][] = [
  ["system", "System (follows this device)"],
  ["light", "Light"],
  ["dark", "Dark"],
];
const ROLES: Record<Role, string> = { owner: "Owner", operator: "Operator", approver: "Approver", requester: "Requester" };

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
      {user.role === "owner" && (
        <>
          <h2>Your office</h2>
          <ul className="list">
            <li>
              <a href="#/settings/business">Business and email</a> <span className="muted">business details, the email sender, Sheets, Slack, Outlook and Teams</span>
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
