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
export function quickJumpItems(role: Role, t: (text: string) => string): QuickJumpItem[] {
  const work = t("Work");
  const build = t("Build");
  const workspace = t("Workspace");
  const owner = role === "owner";

  const items: QuickJumpItem[] = [
    { href: "#/", label: t("Automations"), group: work, icon: "automations" },
    { href: "#/activity", label: t("Activity"), group: work, icon: "activity" },
    { href: "#/bookings", label: t("Bookings"), group: work, icon: "bookings" },
  ];

  if (owner || role === "operator") {
    items.push(
      { href: "#/receipts", label: t("Receipts to review"), group: work, icon: "receipts" },
      { href: "#/knowledge", label: t("Knowledge"), group: work, icon: "knowledge" },
    );
  }

  if (owner) {
    items.push(
      { href: "#/new", label: t("Library"), group: build, icon: "new" },
      { href: "#/ai", label: t("Build with AI"), group: build, icon: "ai" },
      { href: "#/team", label: t("Team"), group: workspace, icon: "team" },
      { href: "#/apps", label: t("Apps"), group: workspace, icon: "apps" },
      { href: "#/settings/business", label: t("Business"), group: workspace, icon: "business" },
      { href: "#/advanced", label: t("Advanced"), group: workspace, icon: "advanced" },
    );
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
  currentHash,
  onClose,
}: {
  open: boolean;
  role: Role;
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

  const filtered = filterQuickJump(quickJumpItems(role, t), query);
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
