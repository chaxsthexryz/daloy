import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

type Suggestion = { id: string; free: boolean; note: string };
type Preset = { label: string; defaultModel: string; needsKey: boolean; models: Suggestion[] };
type Current = { preset: string; model: string; hasKey: boolean; keys: string[]; saved: boolean };
type LocalModels = { ok: boolean; models: string[]; error?: string };
const OTHER = "__other";

type TestResult = { ok: boolean; model: string; sample: string; label?: string; ms?: number; inputTokens?: number; outputTokens?: number; error?: string };

// One plain line per choice, so the trade-off is clear before picking.
const NOTES: Record<string, string> = {
  local: "Runs on this computer: Ollama by default, or the local server set in .env (such as the Hermes app's). Private and free. The server must be running.",
  gemini: "Free tier with a key from Google AI Studio, no credit card. Google may use what you send to improve its products, so use test data.",
  openai: "Your own OpenAI key. Billed by OpenAI.",
  openrouter: "Your own OpenRouter key. One key for many hosted models.",
};
const KEY_LINKS: Record<string, { href: string; text: string }> = {
  gemini: { href: "https://aistudio.google.com/apikey", text: "Get a free key in Google AI Studio" },
  openai: { href: "https://platform.openai.com/api-keys", text: "Create a key on the OpenAI platform" },
  openrouter: { href: "https://openrouter.ai/keys", text: "Create a key on OpenRouter" },
};

/** The AI model every AI step of this user's workflows runs with, and a live test on a sample inquiry. */
export function SettingsPage() {
  const [presets, setPresets] = useState<Record<string, Preset> | null>(null);
  const [current, setCurrent] = useState<Current | null>(null);
  const [local, setLocal] = useState<LocalModels | null>(null);
  const [preset, setPreset] = useState("local");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const data = await api<{ current: Current; presets: Record<string, Preset> }>("GET", "/settings/ai");
    setPresets(data.presets);
    setCurrent(data.current);
    setPreset(data.current.preset);
    setModel(data.current.model);
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
  };
  const keySaved = current?.keys.includes(preset) ?? false;
  // The local server's own list when it answers, otherwise the suggestions.
  const models: Suggestion[] = preset === "local" && local?.ok && local.models.length ? local.models.map((id) => ({ id, free: true, note: "" })) : (presets?.[preset]?.models ?? []);
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
      await api("PUT", "/settings/ai", { preset, model, apiKey: apiKey || undefined });
      setApiKey("");
      await load();
      const saved = `Saved. Your workflows now use ${presets?.[preset]?.label}, model ${model}.`;
      if (alsoTest) {
        setStatus(`${saved} Testing it now…`);
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

  return (
    <main className="page narrow">
      <header className="toolbar plain">
        <a href="#/">Workflows</a>
        <h1>AI model</h1>
      </header>
      <p>Every AI step in your workflows, and Build with AI, uses the model you pick here. You can switch at any time; saved keys are kept for each provider.</p>
      {!presets || !current ? (
        <p>Loading…</p>
      ) : (
        <form onSubmit={save}>
          <p className="in-use">
            In use: <strong>{presets[current.preset]?.label}</strong>, model <code>{current.model}</code>
            {!current.saved && <span className="muted"> (the default from .env)</span>}
          </p>
          <fieldset>
            <legend>Model provider</legend>
            {Object.entries(presets).map(([id, p]) => (
              <div key={id} className="choice">
                <input type="radio" id={`preset-${id}`} name="preset" value={id} checked={preset === id} onChange={() => choose(id)} />
                <label htmlFor={`preset-${id}`}>
                  <span>
                    <strong>{p.label}</strong>
                    {current.saved && current.preset === id && <span className="tag ok">in use</span>}
                    {p.needsKey && current.keys.includes(id) && <span className="tag">key saved</span>}
                  </span>
                  <span className="muted">{NOTES[id]}</span>
                </label>
              </div>
            ))}
          </fieldset>

          <div className="field">
            <label htmlFor="ai-model">Model name</label>
            {preset === "local" && local === null && <span className="muted hint">Checking the local server…</span>}
            {models.length > 0 && (
              <select id="ai-model" value={otherModel ? OTHER : model} onChange={(e) => setModel(e.target.value === OTHER ? "" : e.target.value)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {preset !== "local" && ` (${m.free ? "free" : "paid"})`}
                  </option>
                ))}
                <option value={OTHER}>Other model…</option>
              </select>
            )}
            {(otherModel || models.length === 0) && (
              <input
                id={models.length ? "ai-model-other" : "ai-model"}
                aria-label={models.length ? "Other model name" : undefined}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                required
                maxLength={200}
                placeholder="Any model name the provider offers"
              />
            )}
            {preset === "local" && local?.ok && <span className="muted hint">These are the models on the local server set in .env.</span>}
            {preset === "local" && local && !local.ok && (
              <span className="message error hint">
                The local server is not answering: {local.error}{" "}
                <button type="button" className="quiet" onClick={() => void checkLocal()}>
                  Check again
                </button>
              </span>
            )}
            {suggestion?.note && (
              <span className="muted hint">
                {suggestion.free ? "Free tier." : "Paid."} {suggestion.note}
              </span>
            )}
          </div>

          {presets[preset]?.needsKey && (
            <div className="field">
              <label htmlFor="ai-key">API key {keySaved && <span className="muted">(saved; leave empty to keep it)</span>}</label>
              <input id="ai-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required={!keySaved} maxLength={500} />
              {KEY_LINKS[preset] && (
                <span className="muted hint">
                  <a href={KEY_LINKS[preset].href} target="_blank" rel="noreferrer">
                    {KEY_LINKS[preset].text}
                  </a>
                  . The key is stored encrypted and never shown again.
                </span>
              )}
            </div>
          )}

          <div className="actions">
            <button className="primary" value="save-and-test" disabled={busy}>
              {busy ? "Working…" : "Save and test"}
            </button>
            <button value="save-only" disabled={busy}>
              Save without testing
            </button>
            <button type="button" onClick={testAgain} disabled={busy || !current.saved || preset !== current.preset}>
              Test again
            </button>
          </div>
          <p role="status" className="message ok" hidden={!status}>
            {status}
          </p>
          <p role="alert" className="message error" hidden={!error}>
            {error}
          </p>
        </form>
      )}
      {test && (
        <section aria-label="Test result">
          <h2>Test result</h2>
          <p className="muted">Sample inquiry: “{test.sample}”</p>
          {test.ok ? (
            <p className="message ok">
              Working. {test.model} classified it as <strong>{test.label}</strong> in {test.ms} ms ({test.inputTokens} input and {test.outputTokens} output tokens).
            </p>
          ) : (
            <p className="message error">
              Not working with {test.model}: {test.error}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
