import { useEffect, useState, type CSSProperties } from "react";
import { useLanguage } from "./Language";
import "./toast.css";

export type ToastTone = "info" | "success" | "warn" | "error";

export type ToastPayload = {
  id?: string;
  message: string;
  tone?: ToastTone;
  undoLabel?: string;
  onUndo?: () => void;
  actionHref?: string;
  actionLabel?: string;
  durationMs?: number;
};

type ToastItem = Required<Pick<ToastPayload, "id" | "message" | "tone" | "durationMs">> &
  Pick<ToastPayload, "undoLabel" | "onUndo" | "actionHref" | "actionLabel">;

const EVENT_NAME = "kymavo:toast";

/** Trigger a global white RareUI toast from any console page. */
export function pushToast(payload: ToastPayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ToastPayload>(EVENT_NAME, { detail: payload }));
}

export function ToastHost() {
  const { t } = useLanguage();
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const timers = new Map<string, number>();

    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastPayload>).detail;
      if (!detail?.message) return;
      const id = detail.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const durationMs = detail.durationMs ?? 5000;
      const next: ToastItem = {
        id,
        message: detail.message,
        tone: detail.tone ?? "info",
        undoLabel: detail.undoLabel,
        onUndo: detail.onUndo,
        actionHref: detail.actionHref,
        actionLabel: detail.actionLabel,
        durationMs,
      };
      setItems((prev) => [...prev.filter((p) => p.id !== id).slice(-2), next]);
      const prevTimer = timers.get(id);
      if (prevTimer) window.clearTimeout(prevTimer);
      timers.set(
        id,
        window.setTimeout(() => {
          setItems((prev) => prev.filter((p) => p.id !== id));
          timers.delete(id);
        }, durationMs),
      );
    };

    window.addEventListener(EVENT_NAME, onToast);
    return () => {
      window.removeEventListener(EVENT_NAME, onToast);
      timers.forEach((tid) => window.clearTimeout(tid));
    };
  }, []);

  if (items.length === 0) return null;

  const dismiss = (id: string) => setItems((prev) => prev.filter((p) => p.id !== id));

  return (
    <div className="rare-toast-stack" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} role="status" className="rare-toast ops-toast" data-tone={item.tone}>
          <i className="rare-toast-dot" aria-hidden="true" />
          <span className="rare-toast-msg">{item.message}</span>
          {item.actionHref && item.actionLabel && (
            <a className="ops-toast-undo ops-toast-link" href={item.actionHref} onClick={() => dismiss(item.id)}>
              {item.actionLabel}
            </a>
          )}
          {item.onUndo && (
            <button
              type="button"
              className="ops-toast-undo"
              onClick={() => {
                const fn = item.onUndo;
                dismiss(item.id);
                fn?.();
              }}
            >
              {item.undoLabel ?? t("Undo")}
            </button>
          )}
          <button type="button" className="ops-toast-close" aria-label={t("Dismiss")} onClick={() => dismiss(item.id)}>
            ×
          </button>
          <i
            className="rare-toast-bar"
            aria-hidden="true"
            style={{ animationDuration: `${item.durationMs}ms` } as CSSProperties}
          />
        </div>
      ))}
    </div>
  );
}
