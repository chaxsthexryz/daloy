import "./workspace-admin.css";
import { Text } from "./Language";
import { useEffect, useState } from "react";
import { api, getUsage, type Meter, type Usage } from "./api";
import { day } from "./lib/usage";
import { saveTheme, savedTheme, type Theme } from "./lib/theme";
import { useLanguage } from "./Language";
import { Header } from "./Nav";
import type { Role, User } from "./Team";
import { UsageNotice } from "./UsageNotice";

const THEMES: [Theme, string][] = [
  ["system", "System (follows this device)"],
  ["light", "Light"],
  ["dark", "Dark"],
];
const ROLES: Record<Role, string> = { owner: "Owner", operator: "Operator", approver: "Approver", requester: "Requester" };

const ofLimit = (m: Meter, t: (s: string, values?: Record<string, string | number>) => string) => m.limit === null ? t("{used}, no limit", { used: m.used }) : t("{used} of {limit}", { used: m.used, limit: m.limit });

/** Plan, what this workspace has used and when each count resets. Hidden when /usage cannot be read. */
function PlanAndUsage() {
  const { t } = useLanguage();
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    getUsage().then(setU, () => undefined);
  }, []);
  if (!u) return null;
  const { automations: a } = u;
  return (
    <section aria-labelledby="plan-usage">
      <h2 id="plan-usage">{t("Plan and usage")}</h2>
      <p>{u.plan ? t("Plan: {plan}", { plan: u.label ?? u.plan }) : t("No plan limits are set. The operator sets the plan.")}</p>
      <ul className="list">
        <li>
          {t("AI actions: {count} this month", { count: ofLimit(u.ai, t) })} <span className="muted">{t("(back on {day})", { day: day(u.ai.resetsOn) })}</span>
        </li>
        {u.sms && (
          <li>
            {t("SMS messages: {count} this month", { count: ofLimit(u.sms, t) })} <span className="muted">{t("(back on {day})", { day: day(u.sms.resetsOn) })}</span>
          </li>
        )}
        <li>
          {t("Emails: {count} today", { count: ofLimit(u.email, t) })} <span className="muted">{t("(back on {day})", { day: day(u.email.resetsOn) })}</span>
        </li>
        <li>
          {t("Web requests: {count} today", { count: ofLimit(u.http, t) })} <span className="muted">{t("(back on {day})", { day: day(u.http.resetsOn) })}</span>
        </li>
        <li>{t("Live automations: {count}", { count: a.limit === null ? t("{used}, no limit", { used: a.live }) : t("{used} of {limit}", { used: a.live, limit: a.limit }) })}</li>
        {u.minScheduleMinutes !== null && <li>{t("Shortest schedule: every {minutes} minutes", { minutes: u.minScheduleMinutes })}</li>}
      </ul>
      <UsageNotice usage={u} />
      {u.plan && <p className="muted"><Text>To change your plan, message the Daloy operator. Payment is monthly by GCash or Maya.</Text></p>}
    </section>
  );
}

/** #/settings: how the console looks on this device, the account, and (for owners) the office's settings in one list. */
export function SettingsPage({ user }: { user: User }) {
  const { language, setLanguage, t } = useLanguage();
  const [languageError, setLanguageError] = useState(false);
  const [savingLanguage, setSavingLanguage] = useState(false);
  const changeLanguage = async (next: "en" | "tl") => {
    setSavingLanguage(true);
    setLanguageError(false);
    try {
      const saved = await api<{ language: "en" | "tl" }>("PUT", "/settings/language", { language: next });
      setLanguage(saved.language);
    } catch { setLanguageError(true); }
    finally { setSavingLanguage(false); }
  };
  const [theme, setTheme] = useState(savedTheme);
  const pick = (t: Theme) => {
    setTheme(t);
    saveTheme(t);
  };
  return (
    <main className="page narrow workspace-admin admin-appsettings">
      <Header title={t("Settings")} />
      {user.role === "owner" && <fieldset disabled={savingLanguage}>
        <legend>{t("Language")}</legend>
        <label className="check"><input type="radio" name="language" value="en" checked={language === "en"} onChange={() => void changeLanguage("en")} /> English</label>
        <label className="check"><input type="radio" name="language" value="tl" checked={language === "tl"} onChange={() => void changeLanguage("tl")} /> Taglish</label>
        <p className="muted">{t("Language applies to this workspace.")}</p>
        {languageError && <p role="alert" className="message error">{t("Could not save language. Try again.")}</p>}
      </fieldset>}
      <fieldset>
        <legend>{t("Appearance")}</legend>
        {THEMES.map(([value, label]) => (
          <label key={value} className="check">
            <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => pick(value)} /> {t(label)}
          </label>
        ))}
        <p className="muted">{t("Saved on this device only.")}</p>
      </fieldset>
      <h2>{t("Your account")}</h2>
      <p>
        {t("Signed in as {email}, {role}.", { email: user.email, role: t(ROLES[user.role]) })}
      </p>
      {(user.role === "owner" || user.role === "operator") && <PlanAndUsage />}
      {user.role === "owner" && (
        <>
          <h2>{t("Your office")}</h2>
          <ul className="list">
            <li>
              <a href="#/apps"><Text>Apps</Text></a> <span className="muted">Gmail, Outlook, Google Sheets, Slack and Teams</span>
            </li>
            <li>
              <a href="#/settings/business"><Text>Business</Text></a> <span className="muted"><Text>your business details and the website inquiry form</Text></span>
            </li>
            <li>
              <a href="#/team"><Text>Team</Text></a> <span className="muted"><Text>who can use Daloy and what each person may do</Text></span>
            </li>
            <li>
              <a href="#/resources"><Text>Resources</Text></a> <span className="muted"><Text>rooms, people and tables that bookings reserve</Text></span>
            </li>
            <li>
              <a href="#/settings/ai"><Text>AI model</Text></a> <span className="muted"><Text>which model drafts and classifies, and its key</Text></span>
            </li>
            <li>
              <a href="#/tokens"><Text>API tokens</Text></a> <span className="muted"><Text>for MCP clients and scripts</Text></span>
            </li>
          </ul>
        </>
      )}
    </main>
  );
}
