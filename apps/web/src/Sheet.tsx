import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

const PHONE = "(max-width: 799.98px)";

/** True while the media query matches. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const q = matchMedia(query);
    const on = () => setMatches(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** True under the console's phone breakpoint (800px). */
export const usePhone = () => useMedia(PHONE);

/**
 * A modal dialog: a centered card on a desktop, a bottom sheet on a phone (styles in workspace.css). It uses the native
 * <dialog> so focus stays inside, Escape closes it and focus returns to the button that opened it.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId(); // a sheet can open over another sheet, so the title id must be unique
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="wk-sheet motion-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current.close()}
    >
      <div className="wk-sheet-grip" aria-hidden="true" />
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}

/**
 * A small dialog placed at a point on the screen (the plus that opened it, or the pointer) and kept inside the window. It is a modal
 * <dialog> like Sheet, so focus stays inside, Escape or a click outside closes it, and focus returns to what opened it. The editor
 * uses it for the add menu and the right-click menu on a wide screen; a phone gets the Sheet.
 */
export function Popover({ title, at, hideTitle, className, onClose, children }: { title: string; at: { x: number; y: number }; hideTitle?: boolean; className?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const { width, height } = dialog.getBoundingClientRect();
    dialog.style.left = `${Math.max(8, Math.min(at.x, innerWidth - width - 8))}px`;
    dialog.style.top = `${at.y + 8 + height <= innerHeight - 8 ? at.y + 8 : Math.max(8, at.y - height - 8)}px`;
  }, [at.x, at.y]);
  return (
    <dialog ref={ref} className={`popover ${className ?? ""}`} aria-labelledby={titleId} onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}>
      {/* The dialog has no padding, so a click on it (not on this box) is a click outside. */}
      <div className="popover-body">
        <h2 id={titleId} className={hideTitle ? "visually-hidden" : undefined}>
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}

/** A yes or no question in a Sheet. `onConfirm` runs when the primary button is pressed; the page closes the sheet. */
export function ConfirmSheet({ title, text, confirm, cancel, danger, onConfirm, onClose }: { title: string; text: string; confirm: string; cancel: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet title={title} onClose={onClose}>
      <p className="wk-sheet-text">{text}</p>
      <div className="wk-sheet-actions">
        <button type="button" className={`wk-button ${danger ? "danger" : "blue"}`} onClick={onConfirm}>{confirm}</button>
        <button type="button" className="wk-button" onClick={onClose}>{cancel}</button>
      </div>
    </Sheet>
  );
}
