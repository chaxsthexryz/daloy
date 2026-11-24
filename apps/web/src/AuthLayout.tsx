import "./motion.css";
import "./auth.css";
import type { ReactNode } from "react";

const HEADLINE = "Automate the routine work of your office.";
const POINTS = ["Requests, approvals and replies follow the steps you set.", "Works with the email, chat and sheets your team already uses.", "Every run is logged, so you can see what happened and why."];

/** The kymavo mark from the rail sprite, with the name beside it. */
export function Brand({ dark = true }: { dark?: boolean }) {
  return (
    <span className={`au-brand${dark ? "" : " light"}`}>
      <svg className="au-mark" role="img" aria-label="kymavo"><use href="/navigation.svg#mark" /></svg>
      <span aria-hidden="true">kymavo</span>
    </span>
  );
}

const Icon = ({ kind }: { kind: "ok" | "info" | "error" }) => (
  <svg className="au-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="6.25" />
    {kind === "error" ? <path d="M8 4.75v3.5M8 10.75v.01" /> : <path d="m5.25 8.25 1.9 1.9 3.6-3.9" />}
  </svg>
);

/** A message under the title or a field. Errors are announced at once (alert), the rest politely (status). */
export function AuthNote({ kind, children, id }: { kind: "ok" | "info" | "error"; children: ReactNode; id?: string }) {
  return (
    <p id={id} className={`au-note ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon kind={kind} />
      <span>{children}</span>
    </p>
  );
}

/**
 * The split page of the signed-out console (Doop rows E1 to E5): a dark panel with the pitch and a white form side.
 * Below 800px the panel becomes a header above the form.
 */
export function AuthLayout({ title, points = false, notice, children }: { title: string; points?: boolean; notice?: ReactNode; children: ReactNode }) {
  return (
    <div className="au">
      <aside className="au-side">
        <Brand />
        <div className="au-pitch">
          <p className="au-headline">{HEADLINE}</p>
          {points && (
            <ul>
              {POINTS.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
        </div>
      </aside>
      <main className="au-main">
        <div className="au-form motion-page">
          {notice}
          <h1 className="au-title">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}
