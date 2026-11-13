import { useState, type FormEvent } from "react";
import { api, ApiError, type Workflow } from "./api";
import type { Draft } from "./lib/graph";

type DraftReply = { name: string; summary: string; definition: Draft };
type Line = { who: "you" | "ai" | "error"; text: string };

const noteKey = (id: string) => `daloy:ai-note:${id}`;
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "workflow";

/** Workflow list: describe a workflow, get an unpublished draft in the editor. */
export function BuildWithAi() {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const build = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const draft = await api<DraftReply>("POST", "/ai/draft", { request });
      // A slug that is taken gets -2, -3 and so on.
      let wf: Workflow | undefined;
      for (let n = 1; !wf; n++) {
        try {
          wf = await api<Workflow>("POST", "/workflows", { name: draft.name, slug: n === 1 ? slugify(draft.name) : `${slugify(draft.name)}-${n}` });
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 409) || n >= 20) throw err;
        }
      }
      await api("POST", `/workflows/${wf.id}/versions`, { definition: draft.definition, publish: false });
      try {
        sessionStorage.setItem(noteKey(wf.id), draft.summary);
      } catch {
        // Only the note in the editor's chat is lost.
      }
      location.hash = `#/w/${wf.id}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={build} className="create">
      <h2>Build with AI</h2>
      <div className="field">
        <label htmlFor="ai-request">Describe the workflow in your own words</label>
        <textarea
          id="ai-request"
          rows={3}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          required
          maxLength={2000}
          placeholder="When someone fills my contact form, thank them by email, then send billing questions to billing@mydomain.com and everything else to help@mydomain.com."
        />
      </div>
      <div className="actions">
        <button className="primary" disabled={busy}>
          {busy ? "Building the draft…" : "Build draft"}
        </button>
        <span className="muted">Uses the model on the AI model page. You review the draft before anything runs.</span>
      </div>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
    </form>
  );
}

/** Editor: a short chat that rewrites the current draft. Nothing is saved until the user presses Save or Publish. */
export function AskAi({ workflowId, draft, onApply }: { workflowId: string; draft: Draft; onApply: (d: Draft) => void }) {
  const [lines, setLines] = useState<Line[]>(() => {
    try {
      const note = sessionStorage.getItem(noteKey(workflowId));
      sessionStorage.removeItem(noteKey(workflowId));
      return note ? [{ who: "ai", text: `${note} This is a draft: review it, test run it, then Save or Publish.` }] : [];
    } catch {
      return [];
    }
  });
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = request.trim();
    if (!text) return;
    setLines((l) => [...l, { who: "you", text }]);
    setRequest("");
    setBusy(true);
    try {
      const reply = await api<DraftReply>("POST", "/ai/draft", { request: text, current: draft.steps.length ? draft : undefined });
      onApply(reply.definition);
      setLines((l) => [...l, { who: "ai", text: `${reply.summary} Not saved yet.` }]);
    } catch (err) {
      setLines((l) => [...l, { who: "error", text: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="ask-ai-heading">
      <h2 id="ask-ai-heading">Ask the AI</h2>
      {lines.length > 0 && (
        <ol className="chat" aria-label="Conversation with the AI">
          {lines.map((l, i) => (
            <li key={i} className={`chat-${l.who}`}>
              <strong>{l.who === "you" ? "You" : "AI"}:</strong> {l.text}
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={send}>
        <div className="field">
          <label htmlFor="ask-ai">{draft.steps.length ? "What should change?" : "What should this workflow do?"}</label>
          <textarea id="ask-ai" rows={2} value={request} onChange={(e) => setRequest(e.target.value)} maxLength={2000} placeholder="Wait one day before the email, and send me a summary." />
        </div>
        <button disabled={busy || !request.trim()}>{busy ? "Thinking…" : "Send"}</button>
      </form>
    </section>
  );
}
