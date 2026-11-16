import { useState } from "react";
import type { User } from "./Team";

/**
 * The console header of Automations and Advanced. Wide screens show the links in the row; under 800 px they sit behind one Menu button
 * (styles.css), so nothing is cut off on a phone.
 */
export function Header({ title, user, onSignOut }: { title: string; user: User; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const owner = user.role === "owner";
  const link = (href: string, text: string) => (
    <a href={href} aria-current={title === text ? "page" : undefined} onClick={() => setOpen(false)}>
      {text}
    </a>
  );
  return (
    <header className="toolbar plain console-header">
      <img src="/logo.svg" alt="Daloy" width="28" height="28" />
      <h1>{title}</h1>
      <span className="muted who">{user.email}</span>
      <button type="button" className="quiet menu-button" aria-expanded={open} aria-controls="main-menu" onClick={() => setOpen(!open)}>
        Menu
      </button>
      <nav id="main-menu" aria-label="Main" className={open ? "open" : undefined}>
        {link("#/", "Automations")}
        {(owner || user.role === "operator") && link("#/bookings", "Bookings")}
        {owner && (
          <>
            {link("#/team", "Team")}
            {link("#/settings/business", "Business and email")}
            {link("#/advanced", "Advanced")}
          </>
        )}
        <button type="button" className="quiet" onClick={onSignOut}>
          Sign out
        </button>
      </nav>
    </header>
  );
}
