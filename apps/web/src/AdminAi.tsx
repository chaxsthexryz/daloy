import { useEffect, useState, type FormEvent } from "react";
import type { WorkspaceRow } from "./Admin";
import { api } from "./api";
import { useLanguage } from "./Language";

type Thinking = "off" | "low" | "medium" | "high";
type Preset = { label: string; defaultModel: string; needsKey: boolean; models: { id: string; free: boolean; note: string }[] };
type Shared = { source: "platform" | "env"; preset: string; model: string; thinking: Thinking; hasKey: boolean; keyLast4: string | null };
export type SharedAi = { current: Shared; presets: Record<string, Preset>; keyShared: boolean };
type TestResult = { ok: true; model: string; label: string; ms: number } | { ok: false; model: string; error: string };

const THINKING: { id: Thinking; label: string }[] = [
  { id: "off", label: "Off (fastest)" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High (slowest, most tokens)" },
];

const SHORT: Record<Thinking, string> = { off: "Off", low: "Low", medium: "Medium", high: "High" };

/** The shared AI model (A2, decision 0151) and the thinking override for each workspace on it. */
export function AdminAiTab({ rows, onSaved, onError }: { rows: WorkspaceRow[]; onSaved: () => void; onError: (e: unknown) => void }) {
  const { t } = useLanguage();
  const [ai, setAi] = useState<SharedAi | null>(null);
  useEffect(() => {
    api<SharedAi>("GET", "/admin/ai").then(setAi, onError);
  }, []);
  return (
    <>
      {ai === null ? <p className="wk-sub" role="status">{t("Loading…")}</p> : <SharedModel key={`${ai.current.preset}:${ai.current.model}:${ai.current.thinking}`} ai={ai} onSaved={(next) => { setAi(next); onSaved(); }} />}
      <section className="wk-card" aria-label={t("Thinking per workspace")}>
        <h2 className="wk-card-head"><b>{t("Thinking per workspace")}</b><span>{t("Overrides the shared level for one workspace. A workspace with its own key sets its own.")}</span></h2>
        <div className="ad-scroll">
          <table className="wk-table">
            <thead>
              <tr>
                <th scope="col">{t("Owner")}</th>
                <th scope="col">{t("Plan")}</th>
                <th scope="col">{t("AI actions this cycle")}</th>
                <th scope="col">{t("Thinking")}</th>
                <th scope="col"><span className="wk-sr">{t("Save")}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => <ThinkingLine key={`${w.id}:${w.aiThinking ?? ""}`} row={w} level={ai?.current.thinking} onSaved={onSaved} />)}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function SharedModel({ ai, onSaved }: { ai: SharedAi; onSaved: (next: SharedAi) => void }) {
  const { t } = useLanguage();
  const [preset, setPreset] = useState(ai.current.preset);
  const [model, setModel] = useState(ai.current.model);
  const [thinking, setThinking] = useState<Thinking>(ai.current.thinking);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const p = ai.presets[preset];
  // A saved key belongs to the saved preset; picking another provider needs a new one.
  const keySaved = ai.current.source === "platform" && ai.current.hasKey && ai.current.preset === preset;
  const choose = (id: string) => {
    setPreset(id);
    setModel(id === ai.current.preset ? ai.current.model : (ai.presets[id]?.defaultModel ?? ""));
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const next = await api<SharedAi>("PUT", "/admin/ai", { preset, model: model.trim(), thinking, apiKey: apiKey.trim() || undefined });
      setApiKey("");
      onSaved(next);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  const test = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await api<TestResult>("POST", "/admin/ai/test"));
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return (
    <section className="wk-card" aria-label={t("Shared model")}>
      <h2 className="wk-card-head">
        <b>{t("Shared model")}</b>
        <span>
          {ai.current.source === "env" ? t("Not saved yet: the LLM_ settings in .env apply.") : t("In use: {provider}, model {model}.", { provider: ai.presets[ai.current.preset]?.label ?? ai.current.preset, model: ai.current.model })}
        </span>
      </h2>
      <form className="wk-body ad-form" onSubmit={(e) => void save(e)}>
        <label>
          {t("Provider")}
          <select value={preset} onChange={(e) => choose(e.target.value)}>
            {Object.entries(ai.presets).map(([id, x]) => <option key={id} value={id}>{x.label}</option>)}
          </select>
        </label>
        <label>
          {t("Model name")}
          <input type="text" required maxLength={200} list="ad-models" value={model} onChange={(e) => setModel(e.target.value)} />
          <datalist id="ad-models">{(p?.models ?? []).map((m) => <option key={m.id} value={m.id} />)}</datalist>
        </label>
        <label>
          {t("Thinking")}
          <select value={thinking} onChange={(e) => setThinking(e.target.value as Thinking)}>
            {THINKING.map((l) => <option key={l.id} value={l.id}>{t(l.label)}</option>)}
          </select>
        </label>
        {p?.needsKey && (
          <label>
            {t("API key")}
            <input type="password" autoComplete="off" maxLength={500} required={!keySaved} value={apiKey} placeholder={keySaved && ai.current.keyLast4 ? t("Saved, ends in {last4}", { last4: ai.current.keyLast4 }) : undefined} onChange={(e) => setApiKey(e.target.value)} />
            <span className="wk-muted">{keySaved ? t("Leave empty to keep the saved key. It is stored encrypted and never shown again.") : t("Stored encrypted and never shown again.")}</span>
          </label>
        )}
        {!ai.keyShared && <p className="wk-muted">{t("SHARED_LLM_KEY is not open, so workspaces get the shared model without the saved key.")}</p>}
        <div className="ad-actions">
          <button className="wk-button blue" disabled={busy}>{busy ? t("Working…") : t("Save")}</button>
          <button type="button" className="wk-button" disabled={busy} onClick={() => void test()}>{t("Test the saved model")}</button>
        </div>
        <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
        {result && (
          <p role="status" className={`wk-note${result.ok ? "" : " bad"}`}>
            {result.ok ? t("{model} answered in {ms} ms and labelled the sample inquiry {label}.", { model: result.model, ms: result.ms, label: result.label }) : t("{model} failed: {error}", { model: result.model, error: result.error })}
          </p>
        )}
      </form>
    </section>
  );
}

function ThinkingLine({ row, level, onSaved }: { row: WorkspaceRow; level?: Thinking; onSaved: () => void }) {
  const { t } = useLanguage();
  const saved = row.aiThinking ?? "";
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api("PUT", `/admin/workspaces/${row.id}/ai-thinking`, { level: value || null });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <tr>
      <td className="wk-name">{row.email}</td>
      <td>{row.plan ?? t("No plan")}</td>
      <td>{row.ai}</td>
      <td>
        <select aria-label={t("Thinking for {email}", { email: row.email })} value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">{level ? t("Shared level ({level})", { level: t(SHORT[level]) }) : t("Shared level")}</option>
          {THINKING.map((l) => <option key={l.id} value={l.id}>{t(l.label)}</option>)}
        </select>
        {error && <span role="alert" className="wk-muted ad-bad"> {error}</span>}
      </td>
      <td><button type="button" className="wk-button" disabled={busy || value === saved} onClick={() => void save()}>{t("Save")}</button></td>
    </tr>
  );
}
