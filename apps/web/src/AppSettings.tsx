import "./workspace.css";
import { Text } from "./Language";
import { useEffect, useState, type ReactNode } from "react";
import { api, getUsage, type Meter, type Usage } from "./api";
import { shortDay } from "./lib/usage";
import { saveTheme, savedTheme, type Theme } from "./lib/theme";
import { useLanguage } from "./Language";
import { usePhone } from "./Sheet";
import type { Role, User } from "./Team";
import { UsageNotice } from "./UsageNotice";

const THEMES: [Theme, string][] = [
  ["system", "System (follows this device)"],
  ["light", "Light"],
  ["dark", "Dark"],
];
const ROLES: Record<Role, string> = { owner: "Owner", operator: "Operator", approver: "Approver", requester: "Requester" };

const ofLimit = (m: Meter, t: (s: string, values?: Record<string, string | number>) => string) => m.limit === null ? t("{used}, no limit", { used: m.used }) : t("{used} of {limit}", { used: m.used, limit: m.limit });

function Card({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section className="wk-card" aria-labelledby={id}>
      <h2 className="wk-card-head" id={id}><b>{title}</b></h2>
      {children}
    </section>
  );
}

/** Plan, what this workspace has used and when each count resets. Hidden when /usage cannot be read. */
function PlanAndUsage({ phone }: { phone: boolean }) {
  const { t } = useLanguage();
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    getUsage().then(setU, () => undefined);
  }, []);
  if (!u) return null;
  const { automations: a } = u;
  const back = (m: Meter) => <span className="wk-muted">{phone ? t("back {day}", { day: shortDay(m.resetsOn, false) }) : t("back on {day}", { day: shortDay(m.resetsOn) })}</span>;
  return (
    <Card title={t("Plan and usage")} id="plan-usage">
      <div className="wk-body">
        <p>{u.plan ? <>{t("Plan:")} <b>{u.label ?? u.plan}</b></> : t("No plan limits are set. The operator sets the plan.")}</p>
        <ul className="wk-usage">
          <li><span>{t("AI actions: {count} this month", { count: ofLimit(u.ai, t) })}</span>{back(u.ai)}</li>
          <li><span>{t("Emails: {count} today", { count: ofLimit(u.email, t) })}</span>{back(u.email)}</li>
          <li><span>{t("Web requests: {count} today", { count: ofLimit(u.http, t) })}</span>{back(u.http)}</li>
          <li><span>{t("Live automations: {count}", { count: a.limit === null ? t("{used}, no limit", { used: a.live }) : t("{used} of {limit}", { used: a.live, limit: a.limit }) })}</span></li>
          {u.minScheduleMinutes !== null && <li><span>{t("Shortest schedule: every {minutes} minutes", { minutes: u.minScheduleMinutes })}</span></li>}
        </ul>
        <UsageNotice usage={u} />
        {u.plan && <p className="wk-muted"><Text>To change your plan, message the Daloy operator. Payment is monthly by GCash or Maya.</Text></p>}
      </div>
    </Card>
  );
}

const OFFICE: [href: string, name: string, note: string][] = [
  ["#/apps", "Apps", "Gmail, Outlook, Google Sheets, Slack and Teams"],
  ["#/settings/business", "Business", "your business details and the website inquiry form"],
  ["#/team", "Team", "who can use Daloy and what each person may do"],
  ["#/resources", "Resources", "rooms, people and tables that bookings reserve"],
  ["#/settings/ai", "AI model", "which model drafts and classifies, and its key"],
  ["#/tokens", "API tokens", "for MCP clients and scripts"],
];

/** #/settings: how the console looks on this device, the account, the plan, and (for owners) the office's settings in one list. */
export function SettingsPage({ user }: { user: User }) {
  const { language, setLanguage, t } = useLanguage();
  const phone = usePhone();
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
  const pick = (next: Theme) => {
    setTheme(next);
    saveTheme(next);
  };
  const owner = user.role === "owner";
  // The email is bold in the sentence; the translated template decides where it sits.
  const [before = "", after = ""] = t("Signed in as {email}, {role}.", { email: "\u0000", role: t(ROLES[user.role]) }).split("\u0000");
  return (
    <main className="page wk wk-settings">
      <header className="wk-head">
        <div>
          {phone && <p className="wk-eyebrow"><Text>Workspace</Text></p>}
          <div className="wk-title-row">
            <h1>{t("Settings")}</h1>
            <span className="wk-sub">{phone ? `${user.email}, ${t(ROLES[user.role])}` : t("Signed in as {role}", { role: t(user.role) })}</span>
          </div>
        </div>
      </header>
      <div className="wk-grid">
        <div className="wk-col">
          {owner && (
            <Card title={t("Language")} id="language-card">
              <fieldset className="wk-body wk-radios" disabled={savingLanguage}>
                <legend className="wk-sr">{t("Language")}</legend>
                <label><input type="radio" name="language" value="en" checked={language === "en"} onChange={() => void changeLanguage("en")} /> English</label>
                <label><input type="radio" name="language" value="tl" checked={language === "tl"} onChange={() => void changeLanguage("tl")} /> Taglish</label>
                <p className="wk-muted">{t("Language applies to this workspace.")}</p>
                {languageError && <p role="alert" className="wk-note bad">{t("Could not save language. Try again.")}</p>}
              </fieldset>
            </Card>
          )}
          <Card title={t("Appearance")} id="appearance-card">
            <fieldset className="wk-body wk-radios">
              <legend className="wk-sr">{t("Appearance")}</legend>
              {THEMES.map(([value, label]) => (
                <label key={value}>
                  <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => pick(value)} /> {value === "system" && phone ? t("System") : t(label)}
                </label>
              ))}
              <p className="wk-muted">{t("Saved on this device only.")}</p>
            </fieldset>
          </Card>
          {!phone && (
            <>
              <Card title={t("Your account")} id="account-card">
                <div className="wk-body wk-line">
                  <p>{before}<b>{user.email}</b>{after}</p>
                  <span className="wk-chip">{t(ROLES[user.role])}</span>
                </div>
              </Card>
              {!owner && <p className="wk-muted wk-managed">{t("Language and office settings are managed by the owner.")}</p>}
            </>
          )}
        </div>
        {(owner || user.role === "operator") && <PlanAndUsage phone={phone} />}
      </div>
      {owner && (
        <Card title={t("Your office")} id="office-card">
          <ul className="wk-office">
            {OFFICE.map(([href, name, note]) => (
              <li key={href}>
                <a href={href}><Text>{name}</Text></a>
                <span><Text>{note}</Text></span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {phone && !owner && <p className="wk-muted">{t("Language and office settings are managed by the owner.")}</p>}
    </main>
  );
}
