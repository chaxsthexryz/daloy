import { useEffect, useRef, useState, type ReactNode } from "react";
import "./console-shell.css";
import "./motion.css";
import { api, getUsage, type RunSummary, type Usage } from "./api";
import { CommandPalette, isQuickJumpShortcut } from "./CommandPalette";
import { useLanguage } from "./Language";
import { NotificationBell, useLiveEvents } from "./LiveEvents";
import { diffLiveRuns, LIVE_RUN_EVENT, liveRunToast, type LiveRunSnapshot } from "./lib/live-runs";
import { useSlidingPill } from "./lib/motion";
import { aiMeter } from "./lib/usage";
import { ROLE_LABEL, type User } from "./Team";
import { personName } from "./lib/person";
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
  const inRail = className?.includes("rail-usage") ?? false;
  return (
    <div className={className ?? "ai-meter"}>
      {inRail && (
        <div className="rail-usage-head">
          <strong>{usage.label || t("Business")}</strong>
          <span>{t("Plan")}</span>
        </div>
      )}
      <div className="ai-meter-bar" role="progressbar" aria-label={meter.text} aria-valuemin={0} aria-valuemax={meter.limit} aria-valuenow={Math.min(meter.used, meter.limit)}>
        <i style={{ width: `${meter.percent}%` }} />
      </div>
      <span className="ai-meter-text" aria-hidden="true">{meter.text}</span>
      {inRail && (
        <button type="button" className="rail-usage-btn" onClick={() => { location.hash = "#/settings"; }}>
          {t("Manage plan")}
        </button>
      )}
    </div>
  );
}

export type NavGroupId = "bookings" | "automations" | "business";
export type NavTreeState = Record<NavGroupId, boolean>;

export function sectionGroup(sec: string): NavGroupId | null {
  if (sec === "Bookings") return "bookings";
  if (sec === "Automations") return "automations";
  if (sec === "Business") return "business";
  return null;
}

export function initialTreeState(hash: string): NavTreeState {
  const active = sectionGroup(section(hash));
  return {
    bookings: active === "bookings",
    automations: active === "automations",
    business: active === "business",
  };
}

export function syncTreeForHash(prev: NavTreeState, hash: string): NavTreeState {
  const next = initialTreeState(hash);
  if (prev.bookings === next.bookings && prev.automations === next.automations && prev.business === next.business) return prev;
  return next;
}

export function toggleTreeGroup(prev: NavTreeState, group: NavGroupId): NavTreeState {
  return { ...prev, [group]: !prev[group] };
}

function isSubActive(hash: string, targetHref: string): boolean {
  const [rawPath, rawQuery = ""] = hash.split("?");
  const path = (rawPath ?? "").replace(/\/+$/, "") || "#/";
  const tab = new URLSearchParams(rawQuery).get("tab");
  switch (targetHref) {
    case "#/bookings":
      return path === "#/bookings" && tab !== "rooms";
    case "#/bookings?tab=rooms":
      return (path === "#/bookings" && tab === "rooms") || path === "#/resources";
    case "#/automations":
      return path === "#/automations";
    case "#/ai":
      return path === "#/ai";
    case "#/new":
      return path === "#/new";
    case "#/business":
      return (path === "#/business" && tab !== "knowledge" && tab !== "team")
        || path === "#/settings/business"
        || path.startsWith("#/verify-sender");
    case "#/business?tab=knowledge":
      return (path === "#/business" && tab === "knowledge") || path === "#/knowledge" || path.startsWith("#/knowledge/");
    case "#/business?tab=team":
      return (path === "#/business" && tab === "team") || path.startsWith("#/team");
    default:
      return false;
  }
}

/** Which menu entry a hash route belongs to, so the same menu shows on every page and marks where you are. */
export function section(hash: string) {
  const path = (hash.split("?")[0] ?? "").replace(/\/+$/, "") || "#/";
  if (path === "#/" || path === "#") return "Home";
  if (path.startsWith("#/inbox") || path.startsWith("#/conversations") || path === "#/receipts" || path.startsWith("#/receipts/")) return "Inbox";
  if (path.startsWith("#/bookings") || path.startsWith("#/resources")) return "Bookings";
  if (
    path === "#/automations"
    || path === "#/new"
    || path === "#/ai"
    || path.startsWith("#/w/")
    || path.startsWith("#/a/")
    || path === "#/activity"
    || path.startsWith("#/activity/")
    || path.startsWith("#/runs/")
    || path.startsWith("#/try/")
  ) return "Automations";
  if (
    (path === "#/business" && new URLSearchParams(hash.split("?")[1] ?? "").get("tab") === "apps")
    || path === "#/apps"
    || path.startsWith("#/apps/")
    || path.startsWith("#/settings/business/outlook-")
  ) return "Apps";
  if (path === "#/feedback") return "Support";
  if (
    path.startsWith("#/business")
    || path === "#/knowledge"
    || path.startsWith("#/knowledge/")
    || path.startsWith("#/team")
    || path === "#/settings/business"
    || path.startsWith("#/verify-sender")
  ) return "Business";
  if (/^#\/(advanced|tokens|secrets|settings|account)/.test(path)) return "Settings";
  return "Home";
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
  const [tree, setTree] = useState<NavTreeState>(() => initialTreeState(hash));
  const menuButton = useRef<HTMLButtonElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);
  const helpBtnRef = useRef<HTMLButtonElement>(null);
  const pill = useSlidingPill<HTMLElement>();
  const menu = pill.containerRef;
  const owner = user.role === "owner";
  const canWatchRuns = owner || user.role === "operator";
  const usage = useUsage(owner);
  // One live stream for the bell, in the sidebar on a desktop and in the bottom bar on a phone (decision 0155).
  const live = useLiveEvents(canWatchRuns);
  const [inboxCount, setInboxCount] = useState(0);
  const here = section(hash);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!canWatchRuns || typeof window === "undefined") return;
    let cancelled = false;
    const refresh = () => {
      api<{ counts?: { total?: number } }>("GET", "/inbox")
        .then((res) => {
          if (!cancelled && typeof res.counts?.total === "number") setInboxCount(res.counts.total);
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener("daloy:inbox", refresh);
    window.addEventListener(LIVE_RUN_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("daloy:inbox", refresh);
      window.removeEventListener(LIVE_RUN_EVENT, refresh);
    };
  }, [canWatchRuns]);

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
  useEffect(() => {
    setOpen(false);
    setClosing(false);
    setPaletteOpen(false);
    setHelpOpen(false);
    setTree((prev) => syncTreeForHash(prev, hash));
    pillLeave();
  }, [hash, pillLeave]);
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
  function link(href: string, text: string, icon?: string, name = text, badge?: number, isParent = false) {
    return (
      <a
        className={icon ? (isParent ? "rail-link rail-parent" : "rail-link") : undefined}
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
        {badge !== undefined && badge > 0 && <span className="rail-badge">{badge}</span>}
      </a>
    );
  }
  function renderGroup(groupId: NavGroupId, groupLabel: string, items: Array<{ href: string; text: string; ariaLabel?: string }>) {
    const isOpen = tree[groupId];
    const toggleLabel = isOpen
      ? t("Hide {name} pages", { name: t(groupLabel) })
      : t("Show {name} pages", { name: t(groupLabel) });
    return (
      <div
        className="rail-group"
        data-group={groupId}
        data-open={isOpen ? "true" : "false"}
        data-has-active={here === groupLabel || undefined}
      >
        <button
          type="button"
          className="rail-toggle"
          aria-label={toggleLabel}
          aria-expanded={isOpen}
          aria-controls={`rail-sub-${groupId}`}
          onClick={() => setTree((prev) => toggleTreeGroup(prev, groupId))}
        >
          <svg className="rail-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 18L15 12L9 6" />
          </svg>
        </button>
        <div
          id={`rail-sub-${groupId}`}
          className="rail-children-wrap"
          inert={!isOpen || undefined}
          aria-hidden={!isOpen || undefined}
        >
          <div className="rail-children">
            {items.map((item) => (
              <a
                key={item.href}
                className="rail-sublink"
                href={item.href}
                aria-label={item.ariaLabel}
                data-active={isSubActive(hash, item.href) || undefined}
                tabIndex={isOpen ? undefined : -1}
                onPointerEnter={(event) => pill.onItemEnter(event.currentTarget)}
                onFocus={(event) => pill.onItemEnter(event.currentTarget)}
                onClick={() => { setOpen(false); pill.onContainerLeave(); }}
              >
                <span>{t(item.text)}</span>
              </a>
            ))}
          </div>
        </div>
      </div>
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
          {canWatchRuns && <NotificationBell live={live} />}
          {!open && (
            <button
              type="button"
              className="mobile-icon-btn mobile-search-btn"
              aria-label={t("Quick jump")}
              onClick={() => setPaletteOpen(true)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20.9999 21.0002L16.6599 16.6602M19 11C19 15.4183 15.4183 19 11 19C6.58172 19 3 15.4183 3 11C3 6.58172 6.58172 3 11 3C15.4183 3 19 6.58172 19 11Z" />
              </svg>
            </button>
          )}
          {open && <button type="button" className="quiet phone-close" onClick={closePhone}>{t("Close")}</button>}
        </div>
        <button
          type="button"
          className="rail-search"
          aria-label={t("Search")}
          onClick={() => {
            setOpen(false);
            setClosing(false);
            setPaletteOpen(true);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20.9999 21.0002L16.6599 16.6602M19 11C19 15.4183 15.4183 19 11 19C6.58172 19 3 15.4183 3 11C3 6.58172 6.58172 3 11 3C15.4183 3 19 6.58172 19 11Z" />
          </svg>
          <span>{t("Search")}</span>
          <kbd aria-hidden="true">⌘K</kbd>
        </button>
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
          <span className="rail-group-label">{t("Work")}</span>
          {link("#/", "Home", "home")}
          {canWatchRuns && link("#/inbox", "Inbox", "inbox", "Inbox", inboxCount)}
          {canWatchRuns && link("#/bookings", "Bookings", "bookings", "Bookings", undefined, owner)}
          {owner && renderGroup("bookings", "Bookings", [
            { href: "#/bookings", text: "Calendar" },
            { href: "#/bookings?tab=rooms", text: "Rooms and slots" },
          ])}
          {owner && link("#/automations", "Automations", "automations", "Automations", undefined, true)}
          {owner && renderGroup("automations", "Automations", [
            { href: "#/automations", text: "All automations" },
            { href: "#/ai", text: "Build with AI", ariaLabel: t("Create: Build with AI") },
            { href: "#/new", text: "Templates", ariaLabel: t("Create: Templates") },
          ])}
          <span className="rail-group-label">{t("Workspace")}</span>
          {owner && link("#/apps", "Apps", "apps")}
          {owner && link("#/business", "Business", "business", "Business", undefined, true)}
          {owner && renderGroup("business", "Business", [
            { href: "#/business", text: "Details and branding" },
            { href: "#/business?tab=knowledge", text: "Knowledge" },
            { href: "#/business?tab=team", text: "Team" },
          ])}
          {link("#/settings", "Settings", "settings")}
          {link("#/feedback", "Support", "conversations")}
          {owner && <AiMeter usage={usage} className="ai-meter rail-usage" />}
          <div className="rail-account" ref={helpRef}>
            <span className="rail-avatar" aria-hidden="true">{personName(user).slice(0, 1).toUpperCase()}</span>
            <div className="rail-who">
              <div className="who rail-label rail-who-top"><strong title={user.email}>{personName(user)}</strong><span className="rail-who-role">{t(ROLE_LABEL[user.role])}</span></div>
              <div className="rail-who-links rail-account-actions">
                <a
                  className="account-link"
                  href="#/settings"
                  data-tip={t("Account")}
                  aria-label={t("Account")}
                  onPointerEnter={(event) => pill.onItemEnter(event.currentTarget)}
                  onFocus={(event) => pill.onItemEnter(event.currentTarget)}
                  onClick={() => { setOpen(false); pill.onContainerLeave(); }}
                >
                  <span className="rail-label">{t("Account")}</span>
                </a>
                <span className="rail-who-sep" aria-hidden="true">·</span>
                <button type="button" className="quiet sign-out" onClick={onSignOut}>{t("Sign out")}</button>
              </div>
            </div>
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
            {helpOpen && (
              <div id="rail-help-menu" className="rail-help-menu" role="menu" aria-label={t("Help and support")}>
                {owner && <a role="menuitem" href="#/onboarding" onClick={closeHelp}>{t("Business setup guide")}</a>}
                <p className="rail-help-note">{t("Need help? Message your kymavo operator or open Settings for your plan.")}</p>
              </div>
            )}
          </div>
        </nav>
      </aside>
      <nav className="bottom-bar" aria-label={t("Quick")}>
        {link("#/", "Home")}
        {canWatchRuns && link("#/inbox", "Inbox")}
        {owner ? link("#/automations", "Automations") : canWatchRuns && link("#/bookings", "Bookings")}
        {canWatchRuns && <NotificationBell live={live} />}
        <button ref={menuButton} type="button" className="quiet menu-button" aria-expanded={open && !closing} aria-controls="main-menu"
          onClick={() => { if (open && !closing) closePhone(); else { setClosing(false); setOpen(true); } }}>
          {t("Menu")}
        </button>
      </nav>
      <div className="shell-main" inert={open}>
        <div className="shell-frame">{children}</div>
      </div>
      <CommandPalette open={paletteOpen} role={user.role} admin={user.admin === true} currentHash={hash} onClose={() => setPaletteOpen(false)} />
      <ToastHost />
    </div>
  );
}

/** One automation's tabs: Steps (#/w/:id) and Activity. Opening an automation lands on Steps (decision 0164). */
export function AutomationTabs({ id, here }: { id: string; here: "overview" | "activity" | "steps"; overview?: boolean }) {
  const { t } = useLanguage();
  const tab = (key: typeof here, href: string, text: string) => (
    <a href={href} aria-current={here === key ? "page" : undefined}>
      {t(text)}
    </a>
  );
  return (
    <nav className="tabs" aria-label={t("This automation")}>
      {tab("steps", `#/w/${id}`, "Steps")}
      {tab("activity", `#/w/${id}/runs`, "Activity")}
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
