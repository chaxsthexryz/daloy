import { BROWSER_MAX_ACTIONS, type BrowserAction } from "@daloy/engine";
import { useLanguage } from "./Language";

/** The action list of a browser step (decision 0108). SchemaForm cannot render arrays, so the editor shows this below it. */
const KINDS = ["goto", "click", "fill", "wait", "extract", "screenshot"] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABEL: Record<Kind, string> = { goto: "Open an address", click: "Click", fill: "Type into a field", wait: "Wait for an element", extract: "Read a value", screenshot: "Take a screenshot" };

function blank(kind: Kind, n: number): BrowserAction {
  switch (kind) {
    case "goto":
      return { action: "goto", url: "https://" };
    case "click":
      return { action: "click", text: "" };
    case "fill":
      return { action: "fill", selector: "", value: "" };
    case "wait":
      return { action: "wait", selector: "" };
    case "extract":
      return { action: "extract", selector: "", name: `value_${n}` };
    case "screenshot":
      return { action: "screenshot" };
  }
}

export function BrowserActions({ actions, onChange }: { actions: BrowserAction[]; onChange: (a: BrowserAction[]) => void }) {
  const { t } = useLanguage();
  const set = (i: number, a: BrowserAction) => onChange(actions.map((x, j) => (j === i ? a : x)));
  return (
    <fieldset>
      <legend>{t("Actions on the page")}</legend>
      <p className="muted hint">{t("In order, after the page opens. A selector is CSS, such as .price or #order-button. kymavo never types into password or card fields.")}</p>
      {actions.map((a, i) => {
        const n = i + 1;
        const input = (label: string, value: string, change: (v: string) => void) => <input aria-label={t("Action {number} {field}", { number: n, field: t(label) })} placeholder={t(label)} value={value} onChange={(e) => change(e.target.value)} />;
        return (
          <div className="row" key={i}>
            <select aria-label={t("Action {number}", { number: n })} value={a.action} onChange={(e) => set(i, blank(e.target.value as Kind, n))}>
              {KINDS.map((k) => (
                <option key={k} value={k}>{t(KIND_LABEL[k])}</option>
              ))}
            </select>
            {a.action === "goto" && input("Address", a.url, (url) => set(i, { ...a, url }))}
            {a.action === "click" && (
              <>
                <select aria-label={t("Action {number} finds by", { number: n })} value={a.selector === undefined ? "text" : "selector"} onChange={(e) => set(i, e.target.value === "text" ? { action: "click", text: "" } : { action: "click", selector: "" })}>
                  <option value="text">{t("Visible text")}</option>
                  <option value="selector">{t("Selector")}</option>
                </select>
                {a.selector === undefined ? input("Visible text", a.text ?? "", (text) => set(i, { action: "click", text })) : input("Selector", a.selector, (selector) => set(i, { action: "click", selector }))}
              </>
            )}
            {(a.action === "fill" || a.action === "wait" || a.action === "extract") && input("Selector", a.selector, (selector) => set(i, { ...a, selector }))}
            {a.action === "fill" && input("Text to type", a.value, (value) => set(i, { ...a, value }))}
            {a.action === "extract" && input("Name", a.name, (name) => set(i, { ...a, name }))}
            <button type="button" className="quiet" aria-label={t("Remove action {number}", { number: n })} onClick={() => onChange(actions.filter((_, j) => j !== i))}>{t("Remove")}</button>
          </div>
        );
      })}
      <button type="button" className="quiet" disabled={actions.length >= BROWSER_MAX_ACTIONS} onClick={() => onChange([...actions, blank("extract", actions.length + 1)])}>{t("Add action")}</button>
      {actions.length >= BROWSER_MAX_ACTIONS && <p className="muted hint">{t("A browser step has at most {max} actions.", { max: BROWSER_MAX_ACTIONS })}</p>}
    </fieldset>
  );
}
