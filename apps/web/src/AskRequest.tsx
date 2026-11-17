import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";

type Answer = { headline: string; lines: string[]; fix: { href: string; label: string } | null };
type Reply = { runId: string; reference: string; workflowName: string; answers: { happened: Answer; why: Answer | null; next: Answer } };
type Which = "happened" | "why" | "next";
type Recent = { id: string; reference: string | null; workflowName: string };

const QUESTIONS: { key: Which; label: string }[] = [
  { key: "happened", label: "What happened?" },
  { key: "why", label: "Why did it stop?" },
  { key: "next", label: "What do I do now?" },
];

/** #/ai with AI_ASK on (decision 0041): pick a request by reference and read Daloy's fixed answers. Links only; the optional reword costs one AI action and changes no run. */
export function AskRequest() {
  const [recent, setRecent] = useState<Recent[]>([]);
  const [text, setText] = useState("");
  const [reply, setReply] = useState<Reply | null>(null);
  const [which, setWhich] = useState<Which>("happened");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [language, setLanguage] = useState<"en" | "tl">("en");
  const [wording, setWording] = useState<{ busy: boolean; text: string; error: string }>({ busy: false, text: "", error: "" });

  useEffect(() => {
    api<Recent[]>("GET", "/runs?state=problem").then(
      (list) => setRecent(list.filter((r) => r.reference).slice(0, 5)),
      () => setRecent([]),
    );
  }, []);

  async function load(reference: string) {
    const ref = reference.trim();
    if (!ref) return;
    setText(ref);
    setBusy(true);
    setError("");
    setReply(null);
    setWording({ busy: false, text: "", error: "" });
    try {
      const r = await api<Reply>("GET", `/runs/ask?reference=${encodeURIComponent(ref)}`);
      setReply(r);
      setWhich("happened");
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? "No request with that reference in this office." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void load(text);
  }

  function choose(w: Which) {
    setWhich(w);
    setWording({ busy: false, text: "", error: "" });
  }

  async function reword() {
    if (!reply) return;
    setWording({ busy: true, text: "", error: "" });
    try {
      const r = await api<{ text: string }>("POST", "/runs/ask/reword", { reference: reply.reference, question: which, language });
      setWording({ busy: false, text: r.text, error: "" });
    } catch (err) {
      setWording({ busy: false, text: "", error: (err as Error).message });
    }
  }

  const shown = reply ? (reply.answers[which] ?? reply.answers.happened) : null;
  return (
    <section className="demo-card" aria-labelledby="ask-title">
      <h2 id="ask-title">Ask about a request</h2>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="ask-reference">Request reference</label>
          <input id="ask-reference" value={text} maxLength={40} onChange={(e) => setText(e.target.value)} />
        </div>
        {recent.length > 0 && (
          <>
            <p className="muted">Or pick a request that ran into a problem:</p>
            <ul className="demo-starters">
              {recent.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => void load(r.reference!)}>
                    {r.reference}, {r.workflowName}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="actions">
          <button className="primary" disabled={busy || !text.trim()}>
            Ask
          </button>
        </div>
      </form>
      <p role="status" className="muted">
        {busy ? "Looking up the request..." : ""}
      </p>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {reply && shown && (
        <div>
          <h3>
            {reply.reference}, {reply.workflowName}
          </h3>
          <div className="actions" role="group" aria-label="Question">
            {QUESTIONS.filter((q) => q.key !== "why" || reply.answers.why).map((q) => (
              <button key={q.key} type="button" className={which === q.key ? "primary" : undefined} aria-pressed={which === q.key} onClick={() => choose(q.key)}>
                {q.label}
              </button>
            ))}
          </div>
          <p>
            <strong>{shown.headline}</strong>
          </p>
          {shown.lines.length > 0 && (
            <ul className="list">
              {shown.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          <p>
            {shown.fix && (
              <>
                <a href={shown.fix.href}>{shown.fix.label}</a>
                {" · "}
              </>
            )}
            <a href={`#/runs/${reply.runId}`}>Open this request</a>
          </p>
          <div className="actions">
            <button type="button" disabled={wording.busy} onClick={() => void reword()}>
              Say it in simpler words (uses 1 AI action)
            </button>
            <label htmlFor="ask-language" className="muted">
              Language
            </label>
            <select id="ask-language" value={language} onChange={(e) => setLanguage(e.target.value as "en" | "tl")}>
              <option value="en">English</option>
              <option value="tl">Tagalog</option>
            </select>
          </div>
          <p role="status" className="muted">
            {wording.busy ? "Asking the AI model..." : ""}
          </p>
          {wording.text && (
            <>
              <h4>Written by the AI model</h4>
              <p>{wording.text}</p>
            </>
          )}
          <p role="alert" className="message error" hidden={!wording.error}>
            {wording.error}
          </p>
          <p className="muted">Answers come from Daloy's own rules. Nothing here changes the request.</p>
        </div>
      )}
    </section>
  );
}
