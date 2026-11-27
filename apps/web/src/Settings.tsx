import "./workspace.css";
import { Breadcrumb } from "./Breadcrumb";
import { useLanguage } from "./Language";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

type Suggestion = { id: string; free: boolean; note: string };
type Preset = { label: string; defaultModel: string; needsKey: boolean; models: Suggestion[] };
type Current = { preset: string; model: string; thinking: Thinking; hasKey: boolean; keys: string[]; saved: boolean };
type Thinking = "off" | "low" | "medium" | "high";
type LocalModels = { ok: boolean; models: string[]; error?: string };
const OTHER = "__other";

type TestResult = { ok: boolean; model: string; sample: string; label?: string; ms?: number; inputTokens?: number; outputTokens?: number; error?: string };

// One plain line per choice, so the trade-off is clear before picking.
const NOTES: Record<string, string> = {
  local: "Runs on this computer: Ollama by default, or the local server set in .env (such as the Hermes app's). Private and free. The server must be running.",
  gemini: "Free tier with a key from Google AI Studio, no credit card. Google may use what you send to improve its products, so use test data.",
  openai: "Your own OpenAI key. Billed by OpenAI.",
  openrouter: "Your own OpenRouter key. One key for many hosted models.",
  deepseek: "Your own key from the DeepSeek platform. Billed by DeepSeek per use.",
};
// More thinking can give better answers on hard steps, but each answer is slower and uses more tokens.
const THINKING: { id: Thinking; label: string }[] = [
  { id: "off", label: "Off (fastest)" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High (slowest, most tokens)" },
];
const KEY_LINKS: Record<string, { href: string; text: string }> = {
  gemini: { href: "https://aistudio.google.com/apikey", text: "Get a free key in Google AI Studio" },
  openai: { href: "https://platform.openai.com/api-keys", text: "Create a key on the OpenAI platform" },
  openrouter: { href: "https://openrouter.ai/keys", text: "Create a key on OpenRouter" },
  deepseek: { href: "https://platform.deepseek.com/api_keys", text: "Create a key on the DeepSeek platform" },
};

/** The AI model every AI step of this user's workflows runs with, and a live test on a sample inquiry. */
export function AiModelPage() {
  const { t } = useLanguage();
  const [presets, setPresets] = useState<Record<string, Preset> | null>(null);
  const [current, setCurrent] = useState<Current | null>(null);
  const [local, setLocal] = useState<LocalModels | null>(null);
  const [preset, setPreset] = useState("local");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState<Thinking>("off");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  // The model names the chosen provider says it serves, for the preset they were read for.
  const [offered, setOffered] = useState<{ preset: string; ids: string[] } | null>(null);

  const loadOffered = async (id: string, key?: string) => {
    if (id === "local") return setOffered(null);
    const res = await api<{ ok: boolean; models: string[] }>("POST", "/settings/ai/models", { preset: id, apiKey: key || undefined }).catch(() => null);
    setOffered(res?.ok && res.models.length ? { preset: id, ids: res.models } : null);
  };
  const load = async () => {
    const data = await api<{ current: Current; presets: Record<string, Preset> }>("GET", "/settings/ai");
    setPresets(data.presets);
    setCurrent(data.current);
    setPreset(data.current.preset);
    setModel(data.current.model);
    setThinking(data.current.thinking);
    // The provider's own list, so the picker holds ids it will actually accept.
    void loadOffered(data.current.preset);
  };
  const checkLocal = async () => {
    setLocal(null);
    setLocal(await api<LocalModels>("GET", "/settings/ai/local-models").catch((e: Error) => ({ ok: false, models: [], error: e.message })));
  };
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
    void checkLocal();
  }, []);

  const choose = (id: string) => {
    setPreset(id);
    setModel(id === current?.preset ? current.model : (presets?.[id]?.defaultModel ?? ""));
    setApiKey("");
    setTest(null);
    setStatus("");
    setOffered(null);
    void loadOffered(id);
  };
  const keySaved = current?.keys.includes(preset) ?? false;
  // The provider's own model names once they are known, with the notes from the suggestions where they match.
  const known = presets?.[preset]?.models ?? [];
  const offeredIds = offered?.preset === preset ? offered.ids : null;
  const models: Suggestion[] =
    preset === "local" && local?.ok && local.models.length
      ? local.models.map((id) => ({ id, free: true, note: "" }))
      : preset !== "local" && offeredIds
        ? offeredIds.map((id) => known.find((k) => k.id === id) ?? { id, free: false, note: "" })
        : known;
  // A model name that is not in the list (or blank, right after picking "Other") gets a text box.
  const suggestion = models.find((m) => m.id === model);
  const otherModel = models.length > 0 && !suggestion;

  const runTest = async () => {
    setTest(await api<TestResult>("POST", "/settings/ai/test"));
  };
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Both submit buttons save; only "Save and test" also makes a real model call.
    const alsoTest = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") !== "save-only";
    setError("");
    setStatus("");
    setTest(null);
    setBusy(true);
    try {
      await api("PUT", "/settings/ai", { preset, model, thinking, apiKey: apiKey || undefined });
      setApiKey("");
      await load();
      const saved = t("Saved. Your automations now use {provider}, model {model}.", { provider: presets?.[preset]?.label ?? "", model });
      if (alsoTest) {
        setStatus(t("{saved} Testing it now…", { saved }));
        await runTest();
      }
      setStatus(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const testAgain = async () => {
    setError("");
    setBusy(true);
    try {
      await runTest();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const needsKey = presets?.[preset]?.needsKey ?? false;
  return (
    <main className="page wk wk-ai">
      <header className="wk-head">
        <div>
          <Breadcrumb items={[{ label: t("Settings"), href: "#/settings" }, { label: t("Advanced"), href: "#/advanced" }, { label: t("AI model") }]} />
          <div className="wk-title-row">
            <h1>{t("AI model")}</h1>
          </div>
        </div>
      </header>
      <p className="wk-lead">{t("Every AI step in your automations, and Build with AI, uses the model you pick here. You can switch at any time; saved keys are kept for each provider.")}</p>
      {!presets || !current ? (
        <p className="wk-sub" role="status">{t("Loading…")}</p>
      ) : (
        <form onSubmit={save} className="wk-ai-grid">
          <div className="wk-col">
            <p className="wk-card wk-body in-use">{t("In use: ")}<b>{presets[current.preset]?.label}</b>{t(", model ")}<code>{current.model}</code>
              {!current.saved && <span className="wk-muted">{t(" (the default from .env)")}</span>}
            </p>
            <fieldset className="wk-card wk-body wk-providers">
              <legend className="wk-eyebrow-caps">{t("Model provider")}</legend>
              {Object.entries(presets).map(([id, p]) => (
                <div key={id} className="wk-choice">
                  <input type="radio" id={`preset-${id}`} name="preset" value={id} checked={preset === id} onChange={() => choose(id)} />
                  <label htmlFor={`preset-${id}`}>
                    <span>
                      <b>{p.label}</b>
                      {current.saved && current.preset === id && <span className="wk-tag on">{t("in use")}</span>}
                      {p.needsKey && current.keys.includes(id) && <span className="wk-tag">{t("key saved")}</span>}
                    </span>
                    <small className="wk-choice-note">{t(NOTES[id] ?? "")}</small>
                  </label>
                </div>
              ))}
            </fieldset>
          </div>

          <div className="wk-col">
            <div className="wk-card wk-body wk-fields">
              <div>
                <label htmlFor="ai-model">{t("Model name")}</label>
                {preset === "local" && local === null && <span className="wk-muted">{t("Checking the local server…")}</span>}
                {models.length > 0 && (
                  <select id="ai-model" value={otherModel ? OTHER : model} onChange={(e) => setModel(e.target.value === OTHER ? "" : e.target.value)}>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                        {preset !== "local" && t(m.free ? " (free)" : " (paid)")}
                      </option>
                    ))}
                    <option value={OTHER}>{t("Other model…")}</option>
                  </select>
                )}
                {(otherModel || models.length === 0) && (
                  <input
                    id={models.length ? "ai-model-other" : "ai-model"}
                    type="text"
                    aria-label={models.length ? t("Other model name") : undefined}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    required
                    maxLength={200}
                    placeholder={t("Any model name the provider offers")}
                  />
                )}
                {preset === "local" && local?.ok && <p className="wk-muted wk-hint">{t("These are the models on the local server set in .env.")}</p>}
                {preset === "local" && local && !local.ok && (
                  <p className="wk-muted wk-hint wk-bad">{t("The local server is not answering: ")}{local.error}{" "}
                    <button type="button" className="wk-button" onClick={() => void checkLocal()}>{t("Check again")}</button>
                  </p>
                )}
                {suggestion?.note && (
                  <p className="wk-muted wk-hint">
                    {suggestion.free ? t("Free tier.") : t("Paid.")} {t(suggestion.note)}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="ai-thinking">{t("Thinking")}</label>
                <select id="ai-thinking" value={thinking} onChange={(e) => setThinking(e.target.value as Thinking)}>
                  {THINKING.map((l) => <option key={l.id} value={l.id}>{t(l.label)}</option>)}
                </select>
                <p className="wk-muted wk-hint">
                  {t("How much the model thinks before it answers. Off suits labels, summaries and short replies. More thinking helps hard steps but is slower and uses more tokens.")}
                  {preset === "gemini" && thinking === "off" && ` ${t("Gemini cannot turn thinking off, so Off uses Low.")}`}
                  {preset === "openai" && thinking !== "off" && ` ${t("Only OpenAI reasoning models accept this; others answer with an error.")}`}
                </p>
              </div>

              {needsKey && (
                <div>
                  <label htmlFor="ai-key">{t("API key ")}{keySaved && <span className="wk-muted">{t("(saved; leave empty to keep it)")}</span>}</label>
                  <div className="wk-keybox">
                    <input id="ai-key" type="password" autoComplete="off" value={apiKey} placeholder={keySaved ? "•".repeat(16) : undefined} onChange={(e) => setApiKey(e.target.value)} onBlur={() => apiKey && void loadOffered(preset, apiKey)} required={!keySaved} maxLength={500} />
                    {keySaved && !apiKey && <span className="wk-keybox-hint" aria-hidden="true">{t("saved")}</span>}
                  </div>
                  {KEY_LINKS[preset] && (
                    <p className="wk-muted wk-hint">
                      <a href={KEY_LINKS[preset].href} target="_blank" rel="noreferrer">
                        {t(KEY_LINKS[preset].text)}
                      </a>{t(". The key is stored encrypted and never shown again.")}</p>
                  )}
                </div>
              )}

              <div className="wk-actions">
                <button className="wk-button blue" value="save-and-test" disabled={busy}>
                  {busy ? t("Working…") : t("Save and test")}
                </button>
                <button className="wk-button" value="save-only" disabled={busy}>{t("Save without testing")}</button>
                <button type="button" className="wk-button" onClick={testAgain} disabled={busy || !current.saved || preset !== current.preset}>{t("Test again")}</button>
              </div>
              <p role="status" className="wk-note" hidden={!status}>
                {status}
              </p>
              <p role="alert" className="wk-note bad" hidden={!error}>
                {error}
              </p>
            </div>
            {test && (
              <section className={`wk-card wk-test${test.ok ? "" : " failed"}`} aria-label={t("Test result")}>
                <div className="wk-body">
                  <div className="wk-line">
                    <h2 className="wk-card-title">{t("Test result")}</h2>
                    <span className={`wk-pill ${test.ok ? "ok" : "red"}`}>{test.ok ? t("Working") : t("Not working")}</span>
                  </div>
                  <p className="wk-muted">{t("Sample inquiry: “{sample}”", { sample: test.sample })}</p>
                  {test.ok ? (
                    <p>{t("Working. {model} classified it as ", { model: test.model })}<b>{test.label}</b>{t(" in {ms} ms ({input} input and {output} output tokens).", { ms: test.ms ?? "", input: test.inputTokens ?? "", output: test.outputTokens ?? "" })}</p>
                  ) : (
                    <>
                      <p className="wk-bad">{t("Not working with {model}: {error}", { model: test.model, error: test.error ?? "" })}</p>
                      <p className="wk-muted">{needsKey ? t("Paste a current key above and choose Save and test. Your automations keep using this setting until it works, so AI steps will fail in the meantime.") : t("Check that the local server is running and the model name is right, then choose Save and test. Your automations keep using this setting until it works, so AI steps will fail in the meantime.")}</p>
                    </>
                  )}
                </div>
              </section>
            )}
          </div>
        </form>
      )}
    </main>
  );
}
