import { useEffect, useState, type ReactNode } from "react";
import type { User } from "./Team";

/** Which menu entry a hash route belongs to, so the same menu shows on every page and marks where you are. */
function section(hash: string) {
  if (hash === "#/settings" || hash === "#/settings/ai") return "Settings";
  if (hash.startsWith("#/bookings")) return "Bookings";
  if (hash.startsWith("#/team")) return "Team";
  if (hash.startsWith("#/settings/business") || hash.startsWith("#/verify-sender")) return "Business and email";
  if (/^#\/(advanced|tokens|settings|resources)/.test(hash)) return "Advanced";
  return "Automations";
}

/**
 * The console frame: one menu on the left of every page for staff (a bar with a Menu button under 800 px, styles.css),
 * so the links, the account and Sign out never move between pages.
 */
export function Shell({ user, hash, onSignOut, children }: { user: User; hash: string; onSignOut: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const owner = user.role === "owner";
  const here = section(hash);
  // The phone menu closes on any page change, the browser's Back button included.
  useEffect(() => setOpen(false), [hash]);
  const link = (href: string, text: string, className?: string) => (
    <a href={href} className={className} aria-current={here === text ? "page" : undefined} onClick={() => setOpen(false)}>
      {text}
    </a>
  );
  return (
    <div className="shell">
      <aside className="sidebar console-header">
        <div className="sidebar-top">
          <img src="/logo.svg" alt="Daloy" width="28" height="28" />
          <span className="sidebar-name">Daloy</span>
          <button type="button" className="quiet menu-button" aria-expanded={open} aria-controls="main-menu" onClick={() => setOpen(!open)}>
            Menu
          </button>
        </div>
        <nav id="main-menu" aria-label="Main" className={open ? "open" : undefined}>
          {owner && link("#/new", "New automation", "primary")}
          {link("#/", "Automations")}
          {(owner || user.role === "operator") && link("#/bookings", "Bookings")}
          {owner && (
            <>
              {link("#/team", "Team")}
              {link("#/settings/business", "Business and email")}
              {link("#/advanced", "Advanced")}
            </>
          )}
          {link("#/settings", "Settings")}
          <span className="muted who">{user.email}</span>
          <button type="button" className="quiet" onClick={onSignOut}>
            Sign out
          </button>
        </nav>
      </aside>
      <div className="shell-main">{children}</div>
    </div>
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
