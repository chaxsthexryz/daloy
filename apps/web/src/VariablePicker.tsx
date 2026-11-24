import { useEffect, useRef, useState } from "react";
import { useLanguage } from "./Language";
import { spliceAt, type VariableGroup } from "./lib/variables";

/** Text fields a reference can go into: SchemaForm marks them with data-variable-target. */
const TARGET = "[data-variable-target]";

/** Puts text into a React-controlled field and lets React see it as typing. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * E3: "Insert data from earlier steps". Picking a reference puts it at the cursor of the text field that was focused last in this
 * panel (it keeps that field after focus moves to the picker, so Tab then Enter works, and a phone's keyboard closing does not lose it).
 * With no field chosen yet the reference is copied instead. Previews come from the last test run, never from a live call.
 */
export function VariablePicker({ groups, stale }: { groups: VariableGroup[]; stale: boolean }) {
  const { t } = useLanguage();
  const root = useRef<HTMLElement>(null);
  const target = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [said, setSaid] = useState("");

  useEffect(() => {
    const panel = root.current?.closest(".a7-inspector");
    const remember = (e: Event) => {
      const el = e.target as HTMLElement;
      if (el.matches(TARGET)) target.current = el as HTMLInputElement | HTMLTextAreaElement;
    };
    panel?.addEventListener("focusin", remember);
    return () => panel?.removeEventListener("focusin", remember);
  }, []);

  const insert = (ref: string) => {
    const el = target.current;
    if (!el?.isConnected) {
      void navigator.clipboard.writeText(ref).then(
        () => setSaid(t("Copied {reference}", { reference: ref })),
        () => setSaid(t("Copy failed. Type {reference} into a text field.", { reference: ref })),
      );
      return;
    }
    const { value, caret } = spliceAt(el.value, ref, el.selectionStart, el.selectionEnd);
    setValue(el, value);
    el.focus();
    el.setSelectionRange(caret, caret);
    setSaid(t("Inserted {reference} into {field}", { reference: ref, field: el.labels?.[0]?.firstChild?.textContent?.trim() || el.getAttribute("aria-label") || t("the field") }));
  };

  return (
    <section ref={root} className="a7-group a7-vars" aria-labelledby="insert-heading">
      <h3 id="insert-heading">{t("Insert data from earlier steps")}</h3>
      <p className="muted hint">
        {t("Click a text field, then pick data to insert it at the cursor. With no field chosen, it is copied. Type {secret} for a saved secret; its value is never shown.", { secret: "{{secrets.name}}" })}
      </p>
      {stale && <p className="muted hint">{t("Previews are from before your last change. Test again to refresh them.")}</p>}
      {groups.length === 0 && <p className="muted hint">{t("Nothing comes before this step yet.")}</p>}
      {groups.map((g) => (
        <div key={g.id} className="a7-vars-group" role="group" aria-label={g.kind === "trigger" ? t("From the trigger") : t("From {id}", { id: g.id })}>
          <h4>{g.kind === "trigger" ? t("From the trigger") : t("From {id}", { id: g.id })}</h4>
          {!g.sampled && <p className="muted hint">{t(g.kind === "trigger" ? "No sample data yet." : "Not in a test yet. Run Test this step to see its data.")}</p>}
          <ul className="a7-chips">
            {g.items.map((i) => (
              <li key={i.ref}>
                {/* Mouse down on the button would take focus from the field and lose the cursor, so it is kept there. */}
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(i.ref)} aria-label={t("Insert {reference}", { reference: i.ref })}>
                  <span className="a7-var-path">{i.label}</span>
                  {i.preview !== undefined && <span className="a7-var-preview">{i.preview}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p role="status" className="a7-copied">
        {said}
      </p>
    </section>
  );
}
