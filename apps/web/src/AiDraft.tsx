import { useLanguage } from "./Language";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Workflow } from "./api";
import type { Draft } from "./lib/graph";

type DraftReply = { name: string; summary: string; definition: Draft };
type Line = { who: "you" | "ai" | "error"; text: string };

const noteKey = (id: string) => `daloy:ai-note:${id}`;
const chatKey = (id: string) => `kymavo.editor.ai.${id}`;
const MAX_LINES = 40;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "workflow";

function loadLines(workflowId: string): Line[] {
  const initial: Line[] = [];
  try {
    const saved = localStorage.getItem(chatKey(workflowId));
    if (saved) {
      const parsed = JSON.parse(saved) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (
            item &&
            typeof item === "object" &&
            "who" in item &&
            "text" in item &&
            (item.who === "you" || item.who === "ai" || item.who === "error") &&
            typeof item.text === "string"
          ) {
            initial.push({ who: item.who, text: item.text });
          }
        }
      }
    }
  } catch {
    // storage unavailable
  }
  try {
    const note = sessionStorage.getItem(noteKey(workflowId));
    sessionStorage.removeItem(noteKey(workflowId));
    if (note) {
      initial.push({ who: "ai", text: note });
    }
  } catch {
    // storage unavailable
  }
  return initial.slice(-MAX_LINES);
}

const appendLine = (lines: Line[], entry: Line): Line[] => [...lines, entry].slice(-MAX_LINES);

function saveLines(workflowId: string, lines: Line[]): void {
  try {
    if (lines.length === 0) localStorage.removeItem(chatKey(workflowId));
    else localStorage.setItem(chatKey(workflowId), JSON.stringify(lines.slice(-MAX_LINES)));
  } catch {
    // ignore storage failures
  }
}

/**
 * Creates the workflow and its first version from a draft. Nothing is saved before this is called. `publish` turns it
 * on in the same step, which Build with AI does for a draft the checker found nothing to fix in.
 */
export async function saveDraft(name: string, definition: Draft, summary: string, publish = false): Promise<Workflow> {
  // A slug that is taken gets -2, -3 and on.
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

/** Editor: auto-saved Ask the AI chat that rewrites the current draft without needing a Save chat button. */
export function AskAi({ workflowId, draft, onApply }: { workflowId: string; draft: Draft; onApply: (d: Draft) => void }) {
  const { t } = useLanguage();
  const [lines, setLines] = useState<Line[]>(() => loadLines(workflowId));
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    saveLines(workflowId, lines);
  }, [workflowId, lines]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = request.trim();
    if (!text) return;
    setLines((l) => appendLine(l, { who: "you", text }));
    setRequest("");
    setBusy(true);
    try {
      const reply = await api<DraftReply>("POST", "/ai/draft", { request: text, current: draft.steps.length ? draft : undefined });
      onApply(reply.definition);
      setLines((l) => appendLine(l, { who: "ai", text: `${reply.summary} ${t("Not saved yet.")}` }));
    } catch (err) {
      setLines((l) => appendLine(l, { who: "error", text: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const clearChat = () => {
    setLines([]);
    saveLines(workflowId, []);
  };

  return (
    <section aria-labelledby="ask-ai-heading">
      <div className="ed-ai-head">
        <h2 id="ask-ai-heading">{t("Ask the AI")}</h2>
        {lines.length > 0 && <span className="ed-ai-saved">{t("Auto-saved")}</span>}
      </div>
      {lines.length > 0 && (
        <ol className="chat ed-ai-log" aria-label={t("Conversation with the AI")}>
          {lines.map((l, i) => (
            <li key={i} className={`chat-${l.who} ed-ai-msg ${l.who}`}>
              <div className="ed-ai-msg-meta">
                <strong>{l.who === "you" ? t("You") : l.who === "error" ? t("Error") : "kymavo AI"}</strong>
              </div>
              <div>{l.text}</div>
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={send}>
        <div className="field">
          <label htmlFor="ask-ai">{t(draft.steps.length ? "What should change?" : "What should this workflow do?")}</label>
          <textarea id="ask-ai" rows={2} value={request} onChange={(e) => setRequest(e.target.value)} maxLength={2000} placeholder={t("Wait one day before the email, and send me a summary.")} />
        </div>
        <div className="ed-ai-actions">
          <button disabled={busy || !request.trim()}>{busy ? t("Thinking…") : t("Send")}</button>
          {lines.length > 0 && (
            <button type="button" className="quiet ed-ai-clear" onClick={clearChat} disabled={busy}>
              {t("Clear chat")}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
