import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useLanguage } from "./Language";
import type { Role } from "./Team";

export interface QuickJumpItem {
  href: string;
  label: string;
  group: string;
  icon: string;
}

export interface ShortcutEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Returns the Quick Jump entries visible to the signed-in role. */
export function quickJumpItems(role: Role, t: (text: string) => string, admin = false): QuickJumpItem[] {
  const work = t("Work");
  const workspace = t("Workspace");
  const owner = role === "owner";

  const items: QuickJumpItem[] = [
    { href: "#/", label: t("Home"), group: work, icon: "home" },
  ];

  if (owner || role === "operator") {
    items.push(
      { href: "#/inbox", label: t("Inbox"), group: work, icon: "inbox" },
      { href: "#/bookings", label: t("Bookings"), group: work, icon: "bookings" },
    );
  }

  if (owner) {
    items.push(
      { href: "#/automations", label: t("Automations"), group: work, icon: "automations" },
      { href: "#/new", label: t("New automation"), group: work, icon: "new" },
      { href: "#/business", label: t("Business"), group: workspace, icon: "business" },
      { href: "#/business?tab=knowledge", label: t("Knowledge"), group: workspace, icon: "knowledge" },
      { href: "#/business?tab=apps", label: t("Apps"), group: workspace, icon: "apps" },
      { href: "#/business?tab=team", label: t("Team"), group: workspace, icon: "team" },
      { href: "#/secrets", label: t("Secrets"), group: workspace, icon: "advanced" },
    );
    if (admin) {
      items.push({ href: "#/advanced", label: t("Advanced"), group: workspace, icon: "advanced" });
    }
  }

  items.push(
    { href: "#/settings", label: t("Settings"), group: workspace, icon: "settings" },
    { href: "#/account", label: t("Account"), group: workspace, icon: "team" },
  );

  return items;
}

/** Case-insensitive filter across item label and group. */
export function filterQuickJump(items: QuickJumpItem[], query: string): QuickJumpItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (item) => item.label.toLowerCase().includes(needle) || item.group.toLowerCase().includes(needle),
  );
}

/** Wraps the highlighted Quick Jump index around the filtered list. */
export function stepQuickJumpIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return (((current + delta) % total) + total) % total;
}

/** Matches Cmd+K or Ctrl+K without Alt or Shift. */
export function isQuickJumpShortcut(event: ShortcutEventLike): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
}

/** Modal page switcher opened by Cmd/Ctrl+K or the sidebar Quick jump button. */
export function CommandPalette({
  open,
  role,
  admin = false,
  currentHash,
  onClose,
}: {
  open: boolean;
  role: Role;
  admin?: boolean;
  currentHash: string;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const filtered = filterQuickJump(quickJumpItems(role, t, admin), query);
  const safeIndex = filtered.length > 0 ? Math.min(activeIndex, filtered.length - 1) : 0;

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => stepQuickJumpIndex(index, 1, filtered.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => stepQuickJumpIndex(index, -1, filtered.length));
      return;
    }
    if (event.key === "Enter") {
      const target = filtered[safeIndex];
      if (!target) return;
      event.preventDefault();
      location.hash = target.href;
      onClose();
    }
  }

  return (
    <div
      className="cmd-backdrop motion-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="cmd-dialog motion-dialog" role="dialog" aria-modal="true" aria-label={t("Quick jump")}>
        <div className="cmd-search">
          <svg className="cmd-search-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20.9999 21.0002L16.6599 16.6602M19 11C19 15.4183 15.4183 19 11 19C6.58172 19 3 15.4183 3 11C3 6.58172 6.58172 3 11 3C15.4183 3 19 6.58172 19 11Z" />
          </svg>
          <input
            ref={inputRef}
            type="search"
            className="cmd-input"
            value={query}
            placeholder={t("Jump to a page...")}
            aria-label={t("Jump to a page...")}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKeyDown}
          />
          <kbd className="cmd-kbd" aria-hidden="true">Esc</kbd>
        </div>
        <div className="cmd-list" role="listbox" aria-label={t("Quick jump")}>
          {filtered.length === 0 ? (
            <p className="cmd-empty">{t("No matching pages.")}</p>
          ) : (
            filtered.map((item, index) => (
              <a
                key={item.href}
                href={item.href}
                role="option"
                aria-selected={index === safeIndex}
                aria-current={currentHash === item.href ? "page" : undefined}
                data-active={index === safeIndex || undefined}
                className="cmd-item"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={onClose}
              >
                <svg className="rail-icon" aria-hidden="true">
                  <use href={`/navigation.svg#${item.icon}`} />
                </svg>
                <span className="cmd-item-label">{item.label}</span>
                <span className="cmd-group">{item.group}</span>
              </a>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
