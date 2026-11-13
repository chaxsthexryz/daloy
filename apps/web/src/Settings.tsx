import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

type Preset = { label: string; defaultModel: string; needsKey: boolean };
type Current = { preset: string; model: string; hasKey: boolean; saved: boolean };
type TestResult = { ok: boolean; model: string; sample: string; label?: string; ms?: number; inputTokens?: number; outputTokens?: number; error?: string };

// One plain line per choice, so the trade-off is clear before picking.
const NOTES: Record<string, string> = {
  local: "Runs on this computer with Ollama. Private and free. Ollama must be running with the model pulled (ollama pull llama3.2).",
  gemini: "Free tier with a key from Google AI Studio, no credit card. Google may use what you send to improve its products, so use test data.",
  openai: "Your own OpenAI key. Billed by OpenAI.",
  openrouter: "Your own OpenRouter key. One key for many hosted models.",
};

/** The AI model every AI step of this user's workflows runs with, and a live test on a sample inquiry. */
export function SettingsPage() {
  const [presets, setPresets] = useState<Record<string, Preset> | null>(null);
  const [current, setCurrent] = useState<Current | null>(null);
  const [preset, setPreset] = useState("local");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    const data = await api<{ current: Current; presets: Record<string, Preset> }>("GET", "/settings/ai");
    setPresets(data.presets);
    setCurrent(data.current);
    setPreset(data.current.preset);
    setModel(data.current.model);
  };
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, []);

  const choose = (id: string) => {
    setPreset(id);
    setModel(id === current?.preset ? current.model : (presets?.[id]?.defaultModel ?? ""));
    setApiKey("");
    setTest(null);
  };
  const keySaved = current?.preset === preset && current.hasKey;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setStatus("");
    setTest(null);
    try {
      await api("PUT", "/settings/ai", { preset, model, apiKey: apiKey || undefined });
      setApiKey("");
      await load();
      setStatus(`Saved. Your workflows now use ${presets?.[preset]?.label}, model ${model}.`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const runTest = async () => {
    setError("");
    setTesting(true);
    try {
      setTest(await api<TestResult>("POST", "/settings/ai/test"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <main className="page narrow">
      <header className="toolbar plain">
        <a href="#/">Workflows</a>
        <h1>AI model</h1>
      </header>
      <p>Every AI step in your workflows uses the model you pick here.</p>
      {!presets ? (
        <p>Loading…</p>
      ) : (
        <form onSubmit={save}>
          <fieldset>
            <legend>Model provider</legend>
            {Object.entries(presets).map(([id, p]) => (
              <div key={id} className="choice">
                <input type="radio" id={`preset-${id}`} name="preset" value={id} checked={preset === id} onChange={() => choose(id)} />
                <label htmlFor={`preset-${id}`}>
                  <strong>{p.label}</strong>
                  <span className="muted">{NOTES[id]}</span>
                </label>
              </div>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="ai-model">Model name</label>
            <input id="ai-model" value={model} onChange={(e) => setModel(e.target.value)} required maxLength={200} />
          </div>
          {presets[preset]?.needsKey && (
            <div className="field">
              <label htmlFor="ai-key">API key {keySaved && <span className="muted">(key saved; leave empty to keep it)</span>}</label>
              <input id="ai-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required={!keySaved} maxLength={500} />
            </div>
          )}
          <div className="actions">
            <button className="primary">Save</button>
            <button type="button" onClick={runTest} disabled={testing || (!current?.saved && preset !== "local")}>
              {testing ? "Testing…" : "Test the saved model"}
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
