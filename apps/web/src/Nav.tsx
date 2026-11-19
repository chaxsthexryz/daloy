import { useEffect, useRef, useState, type ReactNode } from "react";
import "./console-shell.css";
import { useLanguage } from "./Language";
import type { User } from "./Team";

/** Which menu entry a hash route belongs to, so the same menu shows on every page and marks where you are. */
function section(hash: string) {
  if (hash === "#/settings") return "Settings";
  if (hash === "#/account") return "Account";
  if (hash === "#/new") return "New automation";
  if (hash === "#/activity" || hash.startsWith("#/runs/")) return "Activity";
  if (hash === "#/ai") return "Build with AI";
  if (hash.startsWith("#/bookings")) return "Bookings";
  if (hash.startsWith("#/team")) return "Team";
  if (hash.startsWith("#/settings/business/outlook-") || hash === "#/apps" || hash.startsWith("#/apps/") || hash.startsWith("#/verify-sender")) return "Apps";
  if (hash === "#/settings/business") return "Business";
  if (/^#\/(advanced|tokens|secrets|settings|resources)/.test(hash)) return "Advanced";
  return "Automations";
}

/**
 * The console frame: one menu on the left of every page for staff (a bar with a Menu button under 800 px),
 * so the links, the account and Sign out never move between pages.
 */
export function Shell({ user, hash, onSignOut, children }: { user: User; hash: string; onSignOut: () => void; children: ReactNode }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLElement>(null);
  const owner = user.role === "owner";
  const here = section(hash);
  // The phone menu closes on any page change, the browser's Back button included.
  useEffect(() => setOpen(false), [hash]);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLAnchorElement>("a")?.focus();
  }, [open]);
  // `name` is the section the link marks, when its text differs from it (the bottom bar says "AI").
  const link = (href: string, text: string, className?: string, name = text) => (
    <a href={href} className={className} aria-current={here === name ? "page" : undefined} onClick={() => setOpen(false)}>
      {t(text)}
    </a>
  );
  return (
    <div className="shell console-shell">
      <aside className="sidebar console-header">
        <div className="sidebar-top">
          <img src="/logo.svg" alt="Daloy" width="28" height="28" />
          <span className="sidebar-name">Daloy</span>
          {owner && (
            <a href="#/new" className="primary top-new">
              {t("New")}
            </a>
          )}
        </div>
        <nav ref={menu} id="main-menu" aria-label={t("Main")} className={open ? "open" : undefined} onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            setOpen(false);
            menuButton.current?.focus();
          }
        }}>
          <span className="shell-nav-label">{t("Work")}</span>
          {link("#/", "Automations")}
          {(owner || user.role === "operator") && link("#/activity", "Activity")}
          {(owner || user.role === "operator") && link("#/bookings", "Bookings")}
          {owner && (
            <>
              <span className="shell-nav-label">{t("Build")}</span>
              {link("#/new", "New automation")}
              {link("#/ai", "Build with AI")}
              <span className="shell-nav-label">{t("Workspace")}</span>
              {link("#/team", "Team")}
              {link("#/apps", "Apps")}
              {link("#/settings/business", "Business")}
              {link("#/advanced", "Advanced")}
            </>
          )}
          {!owner && <span className="shell-nav-label">{t("Workspace")}</span>}
          {link("#/settings", "Settings")}
          <span className="muted who">{user.email}</span>
          {link("#/account", "Account")}
          <button type="button" className="quiet" onClick={onSignOut}>
            {t("Sign out")}
          </button>
        </nav>
      </aside>
      {/* Under 800 px: the main places within thumb reach, and the button that opens the whole menu above it. */}
      <nav className="bottom-bar" aria-label={t("Quick")}>
        {link("#/", "Automations")}
        {(owner || user.role === "operator") && link("#/activity", "Activity")}
        {owner && link("#/ai", "AI", undefined, "Build with AI")}
        <button ref={menuButton} type="button" className="quiet menu-button" aria-expanded={open} aria-controls="main-menu" onClick={() => setOpen(!open)}>
          {t("Menu")}
        </button>
      </nav>
      <div className="shell-main">{children}</div>
    </div>
  );
}

/** One automation's tabs: Overview (guided automations that are on), Activity and Steps. The routes stay as they were. */
export function AutomationTabs({ id, here, overview }: { id: string; here: "overview" | "activity" | "steps"; overview: boolean }) {
  const { t } = useLanguage();
  const tab = (key: typeof here, href: string, text: string) => (
    <a href={href} aria-current={here === key ? "page" : undefined}>
      {t(text)}
    </a>
  );
  return (
    <nav className="tabs" aria-label={t("This automation")}>
      {overview && tab("overview", `#/a/${id}`, "Overview")}
      {tab("activity", `#/w/${id}/runs`, "Activity")}
      {tab("steps", `#/w/${id}`, "Steps")}
    </nav>
  );
}

/** The title row at the top of a page body. */
export function Header({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <header className="toolbar plain console-header">
      <h1>{title}</h1>
      {action && <div className="actions">{action}</div>}
    </header>
  );
}
