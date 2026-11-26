import { useEffect, useRef, useState, type ReactNode } from "react";
import "./console-shell.css";
import "./motion.css";
import { api, getUsage, type RunSummary, type Usage } from "./api";
import { CommandPalette, isQuickJumpShortcut } from "./CommandPalette";
import { useLanguage } from "./Language";
import { diffLiveRuns, LIVE_RUN_EVENT, liveRunToast, type LiveRunSnapshot } from "./lib/live-runs";
import { useSlidingPill } from "./lib/motion";
import { aiMeter } from "./lib/usage";
import type { User } from "./Team";
import { pushToast, ToastHost } from "./Toast";

/** GET /usage once on load, and again when something that spends or frees usage fires a `daloy:usage` window event. */
export function useUsage(enabled = true) {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => { getUsage().then(u => { if (live) setUsage(u); }, () => undefined); };
    load();
    window.addEventListener("daloy:usage", load);
    return () => { live = false; window.removeEventListener("daloy:usage", load); };
  }, [enabled]);
  return usage;
}

/** "AI 120 of 500 this month" with a 4 px bar and visible count. */
export function AiMeter({ usage, className }: { usage: Usage | null; className?: string }) {
  const { t } = useLanguage();
  const meter = usage && aiMeter(usage, t);
  if (!meter) return null;
  return (
    <div className={className ?? "ai-meter"}>
      <div className="ai-meter-bar" role="progressbar" aria-label={meter.text} aria-valuemin={0} aria-valuemax={meter.limit} aria-valuenow={Math.min(meter.used, meter.limit)}>
        <i style={{ width: `${meter.percent}%` }} />
      </div>
      <span className="ai-meter-text" aria-hidden="true">{meter.text}</span>
    </div>
  );
}

/** Which menu entry a hash route belongs to, so the same menu shows on every page and marks where you are. */
export function section(hash: string) {
  const path = (hash.split("?")[0] ?? "").replace(/\/+$/, "") || "#/";
  if (path === "#/settings") return "Settings";
  if (path === "#/account" || path.startsWith("#/account/")) return "Account";
  if (path === "#/new") return "Library";
  if (path === "#/activity" || path.startsWith("#/activity/") || path.startsWith("#/runs/")) return "Activity";
  if (path === "#/ai") return "Build with AI";
  if (path.startsWith("#/bookings")) return "Bookings";
  if (path.startsWith("#/conversations")) return "Conversations";
  if (path === "#/receipts" || path.startsWith("#/receipts/")) return "Receipts to review";
  if (path === "#/knowledge" || path.startsWith("#/knowledge/")) return "Knowledge";
  if (path.startsWith("#/team")) return "Team";
  if (path.startsWith("#/settings/business/outlook-") || path === "#/apps" || path.startsWith("#/apps/") || path.startsWith("#/verify-sender")) return "Apps";
  if (path === "#/settings/business") return "Business";
  if (/^#\/(advanced|tokens|secrets|settings|resources)/.test(path)) return "Settings";
  return "Automations";
}

/**
 * The console frame: a permanent 228 px sidebar on desktop (a bar with a Menu button under 800 px),
 * so the links, Quick jump, the account and Sign out stay in one steady place across pages.
 */
export function Shell({ user, hash, onSignOut, children }: { user: User; hash: string; onSignOut: () => void; children: ReactNode }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);
  const helpBtnRef = useRef<HTMLButtonElement>(null);
  const pill = useSlidingPill<HTMLElement>();
  const menu = pill.containerRef;
  const owner = user.role === "owner";
  const canWatchRuns = owner || user.role === "operator";
  const usage = useUsage(owner);
  const here = section(hash);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!canWatchRuns || typeof window === "undefined") return;
    let cancelled = false;
    let inFlight = false;
    let prev: Map<string, LiveRunSnapshot> | null = null;

    const poll = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const rows = await api<RunSummary[]>("GET", "/runs?test=false&limit=15").catch(() => null);
        if (cancelled || !Array.isArray(rows)) return;
        const { next, changes } = diffLiveRuns(prev, rows);
        prev = next;
        for (const change of changes) {
          if (change.kind === "finished") pushToast(liveRunToast(change, tRef.current));
          window.dispatchEvent(new CustomEvent(LIVE_RUN_EVENT, { detail: change }));
          if (change.kind === "finished") window.dispatchEvent(new Event("daloy:usage"));
        }
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [canWatchRuns]);

  const pillLeave = pill.onContainerLeave;
  // The phone menu, Quick jump, Help menu and hover pill reset on any page change, the browser's Back button included.
  useEffect(() => { setOpen(false); setClosing(false); setPaletteOpen(false); setHelpOpen(false); pillLeave(); }, [hash, pillLeave]);
  useEffect(() => {
    if (!helpOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!helpRef.current?.contains(event.target as Node)) setHelpOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setHelpOpen(false);
        helpBtnRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [helpOpen]);
  useEffect(() => {
    if (open && !closing) menu.current?.querySelector<HTMLAnchorElement>("a")?.focus();
  }, [open, closing, menu]);
  useEffect(() => {
    if (!closing) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => { if (reduced.matches) { setOpen(false); setClosing(false); } };
    reduced.addEventListener("change", finish);
    finish();
    return () => reduced.removeEventListener("change", finish);
  }, [closing]);
  useEffect(() => {
    const wide = matchMedia("(min-width: 800px)");
    const reset = () => {
      setOpen(false);
      setClosing(false);
    };
    wide.addEventListener("change", reset);
    return () => wide.removeEventListener("change", reset);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isQuickJumpShortcut(event)) {
        event.preventDefault();
        setPaletteOpen((was) => !was);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function closePhone() {
    menuButton.current?.focus();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) setOpen(false);
    else setClosing(true);
  }
  function link(href: string, text: string, icon?: string, name = text) {
    return (
      <a
        href={href}
        data-tip={icon ? t(text) : undefined}
        aria-label={icon ? t(text) : undefined}
        aria-current={here === name ? "page" : undefined}
        onPointerEnter={icon ? (event) => pill.onItemEnter(event.currentTarget) : undefined}
        onFocus={icon ? (event) => pill.onItemEnter(event.currentTarget) : undefined}
        onClick={() => { setOpen(false); pill.onContainerLeave(); }}
      >
        {icon && <svg className="rail-icon" aria-hidden="true"><use href={`/navigation.svg#${icon}`} /></svg>}
        <span className={icon ? "rail-label" : undefined}>{t(text)}</span>
      </a>
    );
  }
  const closeHelp = () => { setHelpOpen(false); setOpen(false); pill.onContainerLeave(); };
  return (
    <div className="shell console-shell" data-phone-open={open || undefined} onKeyDown={event => {
      if (event.key !== "Escape") return;
      if (helpOpen) { setHelpOpen(false); helpBtnRef.current?.focus(); return; }
      if (paletteOpen) { setPaletteOpen(false); return; }
      if (open) closePhone();
    }}>
      <aside className="sidebar console-header"
        data-closing={closing || undefined} inert={closing}
        onAnimationEnd={event => {
          if (event.animationName === "rail-sheet-out") { setOpen(false); setClosing(false); }
        }}>
        <div className="sidebar-top">
          <svg className="rail-brand" aria-label="kymavo" role="img"><use href="/navigation.svg#mark" /></svg>
          <span className="sidebar-name rail-label">kymavo</span>
          {open
            ? <button type="button" className="quiet phone-close" onClick={closePhone}>{t("Close")}</button>
            : owner && <a href="#/new" className="primary top-new">{t("New")}</a>}
        </div>
        <nav
          ref={menu}
          id="main-menu"
          aria-label={t("Main")}
          className={open ? "open" : undefined}
          onPointerLeave={pill.onContainerLeave}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) pill.onContainerLeave();
          }}
        >
          <span
            className="rail-hover-pill motion-pill"
            aria-hidden="true"
            style={{
              transform: `translate3d(${pill.pillStyle.left}px, ${pill.pillStyle.top}px, 0)`,
              width: `${pill.pillStyle.width}px`,
              height: `${pill.pillStyle.height}px`,
              opacity: pill.pillStyle.opacity,
            }}
          />
          <span className="shell-nav-label rail-label">{t("Work")}</span>
          {link("#/", "Automations", "automations")}
          {link("#/activity", "Activity", "activity")}
          {link("#/bookings", "Bookings", "bookings")}
          {(owner || user.role === "operator") && link("#/conversations", "Conversations", "conversations")}
          {(owner || user.role === "operator") && link("#/receipts", "Receipts to review", "receipts")}
          {(owner || user.role === "operator") && link("#/knowledge", "Knowledge", "knowledge")}
          {owner && <>
            <span className="shell-nav-label rail-label">{t("Build")}</span>
            {link("#/new", "Library", "new")}
            {link("#/ai", "Build with AI", "ai")}
          </>}
          <span className="shell-nav-label rail-label">{t("Workspace")}</span>
          {owner && <>
            {link("#/team", "Team", "team")}
            {link("#/apps", "Apps", "apps")}
            {link("#/settings/business", "Business", "business")}
          </>}
          {link("#/settings", "Settings", "settings")}
          {owner && <AiMeter usage={usage} className="ai-meter rail-usage" />}
          <div className="rail-account" ref={helpRef}>
            <span className="who rail-label">{user.email}</span>
            <div className="rail-account-actions">
              <a
                className="account-link"
                href="#/account"
                data-tip={t("Account")}
                aria-label={t("Account")}
                aria-current={here === "Account" ? "page" : undefined}
                onPointerEnter={(event) => pill.onItemEnter(event.currentTarget)}
                onFocus={(event) => pill.onItemEnter(event.currentTarget)}
                onClick={() => { setOpen(false); pill.onContainerLeave(); }}
              >
                <span className="rail-avatar" aria-hidden="true">{user.email.slice(0, 1).toUpperCase()}</span>
                <span className="rail-label">{t("Account")}</span>
              </a>
              <button type="button" className="quiet sign-out" onClick={onSignOut}>{t("Sign out")}</button>
              <button
                ref={helpBtnRef}
                type="button"
                className="quiet rail-help-btn"
                aria-label={t("Help and support")}
                aria-expanded={helpOpen}
                aria-haspopup="menu"
                aria-controls="rail-help-menu"
                title={t("Help and support")}
                onClick={() => setHelpOpen((was) => !was)}
              >
                <span aria-hidden="true">?</span>
                <span className="rail-help-label">{t("Help and support")}</span>
              </button>
            </div>
            {helpOpen && (
              <div id="rail-help-menu" className="rail-help-menu" role="menu" aria-label={t("Help and support")}>
                {owner && <a role="menuitem" href="#/onboarding" onClick={closeHelp}>{t("Business setup guide")}</a>}
                {user.ask === true && canWatchRuns && <a role="menuitem" href="#/activity/ask" onClick={closeHelp}>{t("Ask about a request")}</a>}
                <a role="menuitem" href="#/settings" onClick={closeHelp}>{t("Plan and usage")}</a>
                {owner && <a role="menuitem" href="#/apps" onClick={closeHelp}>{t("Connect apps")}</a>}
                <p className="rail-help-note">{t("Need help? Message your kymavo operator or open Settings for your plan.")}</p>
              </div>
            )}
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
      <CommandPalette open={paletteOpen} role={user.role} admin={user.admin === true} currentHash={hash} onClose={() => setPaletteOpen(false)} />
      <ToastHost />
    </div>
  );
}

/** One automation's tabs: Overview (#/a/:id), Activity, and Steps (#/w/:id). */
export function AutomationTabs({ id, here }: { id: string; here: "overview" | "activity" | "steps"; overview?: boolean }) {
  const { t } = useLanguage();
  const tab = (key: typeof here, href: string, text: string) => (
    <a href={href} aria-current={here === key ? "page" : undefined}>
      {t(text)}
    </a>
  );
  return (
    <nav className="tabs" aria-label={t("This automation")}>
      {tab("overview", `#/a/${id}`, "Overview")}
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
