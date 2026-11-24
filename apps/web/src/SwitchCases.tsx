import { SWITCH_MAX_CASES, type SwitchCase } from "@daloy/engine";
import { useLanguage } from "./Language";

const parseEquals = (raw: string): string | number | boolean => {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
};

/** Edits up to 10 literal case branches for a switch step. SchemaForm skips array-of-object fields. */
export function SwitchCases({ cases, onChange }: { cases: SwitchCase[]; onChange: (next: SwitchCase[]) => void }) {
  const { t } = useLanguage();
  const set = (i: number, patch: Partial<SwitchCase>) => onChange(cases.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <fieldset>
      <legend>{t("Cases")}</legend>
      <p className="muted hint">{t("Each case label becomes a branch name (a-z, 0-9, _). Unmatched values follow default.")}</p>
      {cases.map((c, i) => {
        const n = i + 1;
        return (
          <div className="row" key={i}>
            <input aria-label={t("Case {number} branch label", { number: n })} placeholder={t("Branch label")} value={c.label} maxLength={32} onChange={(e) => set(i, { label: e.target.value })} />
            <input aria-label={t("Case {number} match value", { number: n })} placeholder={t("Match value")} value={String(c.equals)} onChange={(e) => set(i, { equals: parseEquals(e.target.value) })} />
            <button type="button" className="quiet" disabled={cases.length <= 1} aria-label={t("Remove case {number}", { number: n })} onClick={() => onChange(cases.filter((_, j) => j !== i))}>{t("Remove")}</button>
          </div>
        );
      })}
      <button type="button" className="quiet" disabled={cases.length >= SWITCH_MAX_CASES} onClick={() => onChange([...cases, { label: `case_${cases.length + 1}`, equals: "" }])}>{t("Add case")}</button>
      {cases.length >= SWITCH_MAX_CASES && <p className="muted hint">{t("A switch step has at most {max} cases.", { max: SWITCH_MAX_CASES })}</p>}
    </fieldset>
  );
}
