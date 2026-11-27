import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "./Language";
import { addNotice, ageText, noticeHref, noticeText, noticeToast, parseEvent, unreadCount, type Notice } from "./lib/live-events";
import { pushToast } from "./Toast";
import "./live-events.css";

/** How long to wait before opening the stream again when the browser has given up on it (a refusal, not a dropped connection). */
const REOPEN_MS = 30_000;

/**
 * Opens GET /events while `enabled` and keeps the latest events (decision 0155). EventSource reconnects by itself after a
 * dropped connection; when the server refuses (too many streams, signed out) the browser stops, so it is reopened here
 * after a pause. Leaving the console or signing out unmounts the Shell, which closes the stream.
 */
export function useLiveEvents(enabled: boolean) {
  const { t } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const [items, setItems] = useState<Notice[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    let timer: number | undefined;
    let stopped = false;
    const open = () => {
      source = new EventSource("/events");
      source.onmessage = (message: MessageEvent<string>) => {
        const event = parseEvent(message.data);
        if (!event) return;
        setItems((list) => addNotice(list, event, `${message.lastEventId || "e"}-${++seq.current}`));
        const toast = noticeToast(event, tRef.current);
        if (toast) pushToast(toast);
        // A finished run changes usage and the inbox count; the existing listeners refresh on these.
        if (event.kind === "run_succeeded" || event.kind === "run_failed") window.dispatchEvent(new Event("daloy:usage"));
        window.dispatchEvent(new Event("daloy:inbox"));
      };
      source.onerror = () => {
        if (stopped || source?.readyState !== EventSource.CLOSED) return;
        timer = window.setTimeout(open, REOPEN_MS);
      };
    };
    open();
    return () => {
      stopped = true;
      source?.close();
      window.clearTimeout(timer);
    };
  }, [enabled]);

  const markAllRead = useCallback(() => setItems((list) => list.map((n) => ({ ...n, unread: false }))), []);
  const markRead = useCallback((key: string) => setItems((list) => list.map((n) => (n.key === key ? { ...n, unread: false } : n))), []);
  return { items, markAllRead, markRead };
}

/** The bell with an unread count and a dropdown of recent events that link to the run or conversation. */
export function NotificationBell({ live, className }: { live: ReturnType<typeof useLiveEvents>; className?: string }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const unread = unreadCount(live.items);
  const label = unread ? t("Notifications, {count} unread", { count: unread }) : t("Notifications");

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={className ? `notif ${className}` : "notif"} ref={wrap}>
      <button ref={button} type="button" className="notif-btn" aria-haspopup="dialog" aria-expanded={open} aria-controls="notif-panel" aria-label={label} title={label} onClick={() => setOpen((was) => !was)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10.268 21a2 2 0 0 0 3.464 0M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
        </svg>
        {unread > 0 && <span className="notif-dot" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div id="notif-panel" className="notif-panel" role="dialog" aria-label={t("Notifications")}>
          <div className="notif-head">
            <span>{t("Notifications")}</span>
            <button type="button" className="quiet" onClick={live.markAllRead} disabled={unread === 0}>{t("Mark all read")}</button>
          </div>
          <ul className="notif-list" aria-live="polite">
            {live.items.map((n) => (
              <li key={n.key}>
                <a className="notif-item" href={noticeHref(n)} data-unread={n.unread} data-kind={n.kind} onClick={() => { live.markRead(n.key); setOpen(false); }}>
                  <i aria-hidden="true" />
                  <strong>{noticeText(n, t).title}</strong>
                  <small>{ageText(n.at, Date.now(), t)}</small>
                </a>
              </li>
            ))}
          </ul>
          {live.items.length === 0 && <p className="notif-empty">{t("No notifications yet. New chats, handoffs and runs show here as they happen.")}</p>}
          <p className="notif-foot">{t("Live while the console is open. Change what shows here in Settings.")}</p>
        </div>
      )}
    </div>
  );
}
