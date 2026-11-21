import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const PHONE = "(max-width: 799.98px)";

/** True under the console's phone breakpoint (800px). */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => matchMedia(PHONE).matches);
  useEffect(() => {
    const q = matchMedia(PHONE);
    const on = () => setPhone(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return phone;
}

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
