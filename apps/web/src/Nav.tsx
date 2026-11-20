import { useEffect, useRef, useState, type ReactNode } from "react";
import "./console-shell.css";
import "./motion.css";
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
  const [closing, setClosing] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLElement>(null);
  const owner = user.role === "owner";
  const here = section(hash);
  // The phone menu closes on any page change, the browser's Back button included.
  useEffect(() => { setOpen(false); setClosing(false); }, [hash]);
  useEffect(() => {
    if (open && !closing) menu.current?.querySelector<HTMLAnchorElement>("a")?.focus();
  }, [open, closing]);
  useEffect(() => {
    if (!closing) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => { if (reduced.matches) { setOpen(false); setClosing(false); } };
    reduced.addEventListener("change", finish);
    finish();
    return () => reduced.removeEventListener("change", finish);
  }, [closing]);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const wide = matchMedia("(min-width: 800px)");
    const reset = () => {
      clearTimeout(hoverTimer.current);
      setHovered(false);
      setFocused(false);
      setOpen(false);
      setClosing(false);
    };
    wide.addEventListener("change", reset);
    return () => { clearTimeout(hoverTimer.current); wide.removeEventListener("change", reset); };
  }, []);
  function closePhone() {
    menuButton.current?.focus();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) setOpen(false);
    else setClosing(true);
  }
  function link(href: string, text: string, icon?: string, name = text) {
    return <a href={href} aria-current={here === name ? "page" : undefined} onClick={() => setOpen(false)}>
      {icon && <svg className="rail-icon" aria-hidden="true"><use href={`/navigation.svg#${icon}`} /></svg>}
      <span className={icon ? "rail-label" : undefined}>{t(text)}</span>
    </a>;
  }
  return (
    <div className="shell console-shell" data-phone-open={open || undefined} onKeyDown={event => {
      if (event.key !== "Escape") return;
      clearTimeout(hoverTimer.current);
      setHovered(false);
      setFocused(false);
      if (open) closePhone();
    }}>
      <aside className="sidebar console-header" data-expanded={hovered || focused || undefined}
        data-closing={closing || undefined} inert={closing}
        onAnimationEnd={event => {
          if (event.animationName === "rail-sheet-out") { setOpen(false); setClosing(false); }
        }}
        onPointerEnter={event => {
          if (event.pointerType === "touch" || !matchMedia("(min-width: 800px)").matches) return;
          clearTimeout(hoverTimer.current);
          if (matchMedia("(prefers-reduced-motion: reduce)").matches) setHovered(true);
          else hoverTimer.current = setTimeout(() => setHovered(true), 150);
        }}
        onPointerLeave={event => {
          clearTimeout(hoverTimer.current);
          setHovered(false);
          if (!event.currentTarget.querySelector(":focus-visible")) setFocused(false);
        }}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
        <div className="sidebar-top">
          <svg className="rail-brand" aria-label="Daloy" role="img"><use href="/navigation.svg#mark" /></svg>
          <span className="sidebar-name rail-label">Daloy</span>
          {open
            ? <button type="button" className="quiet phone-close" onClick={closePhone}>{t("Close")}</button>
            : owner && <a href="#/new" className="primary top-new">{t("New")}</a>}
        </div>
        <nav ref={menu} id="main-menu" aria-label={t("Main")} className={open ? "open" : undefined}>
          <span className="shell-nav-label rail-label">{t("Work")}</span>
          {link("#/", "Automations", "automations")}
          {link("#/activity", "Activity", "activity")}
          {link("#/bookings", "Bookings", "bookings")}
          {owner && <>
            <span className="shell-nav-label rail-label">{t("Build")}</span>
            {link("#/new", "New automation", "new")}
            {link("#/ai", "Build with AI", "ai")}
          </>}
          <span className="shell-nav-label rail-label">{t("Workspace")}</span>
          {owner && <>
            {link("#/team", "Team", "team")}
            {link("#/apps", "Apps", "apps")}
            {link("#/settings/business", "Business", "business")}
            {link("#/advanced", "Advanced", "advanced")}
          </>}
          {link("#/settings", "Settings", "settings")}
          <div className="rail-account">
            <span className="who rail-label">{user.email}</span>
            <a className="account-link" href="#/account" aria-current={here === "Account" ? "page" : undefined} onClick={() => setOpen(false)}>
              <span className="rail-avatar" aria-hidden="true">{user.email.slice(0, 1).toUpperCase()}</span>
              <span className="rail-label">{t("Account")}</span>
            </a>
            <button type="button" className="quiet sign-out" onClick={onSignOut}>{t("Sign out")}</button>
          </div>
        </nav>
      </aside>
      <nav className="bottom-bar" aria-label={t("Quick")}>
        {link("#/", "Automations")}
        {link("#/activity", "Activity")}
        {owner && link("#/ai", "AI", undefined, "Build with AI")}
        <button ref={menuButton} type="button" className="quiet menu-button" aria-expanded={open && !closing} aria-controls="main-menu"
          onClick={() => { if (open && !closing) closePhone(); else { setClosing(false); setOpen(true); } }}>
          {t("Menu")}
        </button>
      </nav>
      <div className="shell-main" inert={open}>{children}</div>
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
