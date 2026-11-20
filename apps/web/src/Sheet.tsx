import { useEffect, useRef, useState, type ReactNode } from "react";

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
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="wk-sheet motion-dialog"
      aria-labelledby="wk-sheet-title"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current.close()}
    >
      <div className="wk-sheet-grip" aria-hidden="true" />
      <h2 id="wk-sheet-title">{title}</h2>
      {children}
    </dialog>
  );
}
