import "./workspace.css";
import { Text } from "./Language";
import { useState, type ReactNode } from "react";
import { api, type Meter } from "./api";
import { shortDay } from "./lib/usage";
import { saveTheme, savedTheme, type Theme } from "./lib/theme";
import { useLanguage } from "./Language";
import { AiMeter, useUsage } from "./Nav";
import { usePhone } from "./Sheet";
import { personName } from "./lib/person";
import type { Role, User } from "./Team";
import { NotificationsCard } from "./NotificationSettings";
import { AccountCards } from "./Account";
import { UsageNotice } from "./UsageNotice";

const THEMES: [Theme, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];
const ROLES: Record<Role, string> = { owner: "Owner", operator: "Operator", approver: "Approver", requester: "Requester" };

const ofLimit = (m: Meter, t: (s: string, values?: Record<string, string | number>) => string) => m.limit === null ? t("{used}, no limit", { used: m.used }) : t("{used} of {limit}", { used: m.used, limit: m.limit });

function Card({ title, id, icon, children }: { title: string; id: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="wk-card" aria-labelledby={id}>
      <h2 className="wk-card-head" id={id}>
        <span className="wk-card-title-group">
          {icon && <span className="card-ico" aria-hidden="true">{icon}</span>}
          <b>{title}</b>
        </span>
      </h2>
      {children}
    </section>
  );
}

const SETTINGS_ICONS = {
  sliders: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>,
  activity: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3 8l4-16l3 8h4" /></svg>,
  server: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="8" rx="2" /><rect x="3" y="12" width="18" height="8" rx="2" /><path d="M7 8h.01M7 16h.01" /></svg>,
};

/** Plan, what this workspace has used and when each count resets. Hidden when /usage cannot be read. */
function PlanAndUsage({ phone }: { phone: boolean }) {
  const { t } = useLanguage();
  const u = useUsage();
  if (!u) return null;
  const { automations: a } = u;
  const back = (m: Meter) => <span className="wk-muted">{phone ? t("back {day}", { day: shortDay(m.resetsOn, false) }) : t("back on {day}", { day: shortDay(m.resetsOn) })}</span>;
  return (
    <Card title={t("Plan and usage")} id="plan-usage" icon={SETTINGS_ICONS.activity}>
      <div className="wk-body">
        <p>{u.plan ? <>{t("Plan:")} <b>{u.label ?? u.plan}</b></> : t("No plan limits are set. The operator sets the plan.")}</p>
        <AiMeter usage={u} />
        <ul className="wk-usage">
          <li><span>{t("AI actions: {count} this month", { count: ofLimit(u.ai, t) })}</span>{back(u.ai)}</li>
          {u.sms && <li><span>{t("SMS messages: {count} this month", { count: ofLimit(u.sms, t) })}</span>{back(u.sms)}</li>}
          <li><span>{t("Emails: {count} today", { count: ofLimit(u.email, t) })}</span>{back(u.email)}</li>
          <li><span>{t("Web requests: {count} today", { count: ofLimit(u.http, t) })}</span>{back(u.http)}</li>
          <li><span>{t("Live automations: {count}", { count: a.limit === null ? t("{used}, no limit", { used: a.live }) : t("{used} of {limit}", { used: a.live, limit: a.limit }) })}</span></li>
          {u.minScheduleMinutes !== null && <li><span>{t("Shortest schedule: every {minutes} minutes", { minutes: u.minScheduleMinutes })}</span></li>}
        </ul>
        <UsageNotice usage={u} />
        {u.plan && <p className="wk-muted"><Text>To change your plan, message the kymavo operator. Payment is monthly by GCash or Maya.</Text></p>}
      </div>
    </Card>
  );
}

const ADVANCED_OWNER: [href: string, name: string, note: string][] = [
  ["#/secrets", "Secrets", "Named keys and webhook signing secrets for HTTP steps"],
  ["#/automations", "All automations", "Full status table and advanced tools"],
];
const ADVANCED_ADMIN: [href: string, name: string, note: string][] = [
  ["#/tokens", "API tokens", "Tokens for scripts and external tools"],
  ["#/settings/ai", "AI model", "Choose which AI model writes drafts and replies"],
  ["#/advanced", "Platform tools", "Server checks and advanced controls"],
];

/** #/settings: how the console looks on this device, the account, the plan, and (for owners) the office's settings in one list. */
export function SettingsPage({ user, onName }: { user: User; onName: (displayName: string | null) => void }) {
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
  const staff = owner || user.role === "operator";
  return (
    <main className="page wk wk-settings">
      <header className="wk-head">
        <div>
          <div className="wk-title-row">
            <h1>{t("Settings")}</h1>
            <span className="wk-sub">{personName(user)} · {t(ROLES[user.role])}</span>
          </div>
        </div>
      </header>
      <div className="wk-grid">
        <div className="wk-col">
          <AccountCards user={user} onName={onName} />
          <Card title={owner ? t("Appearance & Language") : t("Appearance")} id="appearance-card" icon={SETTINGS_ICONS.sliders}>
            <div className="wk-body wk-seg-rows">
              <fieldset className="wk-seg-row">
                <legend>{t("Theme")}</legend>
                <span className="wk-seg">
                  {THEMES.map(([value, label]) => (
                    <label key={value}>
                      <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => pick(value)} /> {t(label)}
                    </label>
                  ))}
                </span>
              </fieldset>
              {owner && (
                <fieldset className="wk-seg-row" disabled={savingLanguage}>
                  <legend>{t("Workspace language")}</legend>
                  <span className="wk-seg">
                    <label><input type="radio" name="language" value="en" checked={language === "en"} onChange={() => void changeLanguage("en")} /> English</label>
                    <label><input type="radio" name="language" value="tl" checked={language === "tl"} onChange={() => void changeLanguage("tl")} /> Taglish</label>
                  </span>
                </fieldset>
              )}
              {!owner && <p className="wk-muted">{t("Saved on this device only.")}</p>}
              {languageError && <p role="alert" className="wk-note bad">{t("Could not save language. Try again.")}</p>}
              {!owner && <p className="wk-muted wk-managed">{t("Language and office settings are managed by the owner.")}</p>}
            </div>
          </Card>
          {owner && (
            <Card title={t("Advanced")} id="advanced-card" icon={SETTINGS_ICONS.server}>
              <ul className="wk-office">
                {(user.admin ? [...ADVANCED_OWNER, ...ADVANCED_ADMIN] : ADVANCED_OWNER).map(([href, name, note]) => (
                  <li key={href}>
                    <a href={href}><Text>{name}</Text></a>
                    <span><Text>{note}</Text></span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        {staff && (
          <div className="wk-col">
            <NotificationsCard />
            <PlanAndUsage phone={phone} />
          </div>
        )}
      </div>
    </main>
  );
}
