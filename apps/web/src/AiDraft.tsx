import { useLanguage } from "./Language";
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

/**
 * Creates the workflow and its first version from a draft. Nothing is saved before this is called. `publish` turns it
 * on in the same step, which Build with AI does for a draft the checker found nothing to fix in.
 */
export async function saveDraft(name: string, definition: Draft, summary: string, publish = false): Promise<Workflow> {
  // A slug that is taken gets -2, -3 and so on.
  let wf: Workflow | undefined;
  for (let n = 1; !wf; n++) {
    try {
      wf = await api<Workflow>("POST", "/workflows", { name, slug: n === 1 ? slugify(name) : `${slugify(name)}-${n}` });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409) || n >= 20) throw err;
    }
  }
  await api("POST", `/workflows/${wf.id}/versions`, { definition, publish });
  try {
    sessionStorage.setItem(noteKey(wf.id), summary);
  } catch {
    // Only the note in the editor's chat is lost.
  }
  return wf;
}

/** Editor: a short chat that rewrites the current draft. Nothing is saved until the user presses Save or Publish. */
export function AskAi({ workflowId, draft, onApply }: { workflowId: string; draft: Draft; onApply: (d: Draft) => void }) {
  const { t } = useLanguage();
  const [lines, setLines] = useState<Line[]>(() => {
    try {
      const note = sessionStorage.getItem(noteKey(workflowId));
      sessionStorage.removeItem(noteKey(workflowId));
      return note ? [{ who: "ai", text: `${note} ${t("This is a draft: review it, test run it, then Save or Publish.")}` }] : [];
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
      setLines((l) => [...l, { who: "ai", text: `${reply.summary} ${t("Not saved yet.")}` }]);
    } catch (err) {
      setLines((l) => [...l, { who: "error", text: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="ask-ai-heading">
      <h2 id="ask-ai-heading">{t("Ask the AI")}</h2>
      {lines.length > 0 && (
        <ol className="chat" aria-label={t("Conversation with the AI")}>
          {lines.map((l, i) => (
            <li key={i} className={`chat-${l.who}`}>
              <strong>{l.who === "you" ? t("You") : "AI"}:</strong> {l.text}
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={send}>
        <div className="field">
          <label htmlFor="ask-ai">{t(draft.steps.length ? "What should change?" : "What should this workflow do?")}</label>
          <textarea id="ask-ai" rows={2} value={request} onChange={(e) => setRequest(e.target.value)} maxLength={2000} placeholder={t("Wait one day before the email, and send me a summary.")} />
        </div>
        <button disabled={busy || !request.trim()}>{busy ? "Thinking…" : "Send"}</button>
      </form>
    </section>
  );
}
