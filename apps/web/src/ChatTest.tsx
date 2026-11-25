import "./chat-test.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { useLanguage } from "./Language";
import { useRun } from "./Runs";
import { aiFailure, chatPayload, chatReply, isChatTrigger, type ChatTurn } from "./lib/chat-test";
import type { Draft } from "./lib/graph";

type Bubble = { id: number; from: "customer" | "bot"; text: string; note?: string; pending?: boolean };
type Sending = { bubble: number; runId: string; payload: unknown; mocked: boolean };

/**
 * "Chat as your customer" (T8): each message the owner types starts an "ai" test run of the draft. The bot bubble is
 * the reply step's resolved text, or the path the run took. The chat lives only in this component's state.
 */
export function ChatTest({ workflowId, draft, onRun }: { workflowId: string; draft: Draft; onRun: (runId: string) => void }) {
  const { t } = useLanguage();
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState<Sending | null>(null);
  const next = useRef(1);
  const { run } = useRun(sending?.runId ?? null);

  const fill = (id: number, b: Partial<Bubble>) => setBubbles((all) => all.map((x) => (x.id === id ? { ...x, ...b, pending: false } : x)));
  const start = async (payload: unknown, mode: "ai" | "mock") => {
    const r = await api<{ id: string }>("POST", `/workflows/${workflowId}/test-runs`, { definition: draft, payload, mode, choices: {} });
    onRun(r.id);
    return r.id;
  };

  useEffect(() => {
    if (!sending || !run || run.id !== sending.runId) return;
    const failure = sending.mocked ? null : aiFailure(draft, run);
    if (failure) {
      // No model answered (none set up, no key, the AI limit): stop the retries and show the same message mocked.
      const note = t("The AI step failed ({error}), so this answer comes from a mocked run.", { error: failure });
      setSending(null);
      void api("POST", `/runs/${run.id}/cancel`).catch(() => undefined);
      start(sending.payload, "mock").then(
        (runId) => {
          setBubbles((all) => all.map((x) => (x.id === sending.bubble ? { ...x, note } : x)));
          setSending({ ...sending, runId, mocked: true });
        },
        (e: Error) => fill(sending.bubble, { text: e.message, note }),
      );
      return;
    }
    const reply = chatReply(draft, run);
    if (reply.kind === "pending") return;
    setSending(null);
    if (reply.kind === "reply") return fill(sending.bubble, { text: reply.text });
    const path = t("No reply step ran. The run went: {path}.", { path: reply.steps.join(" → ") || t("no steps") });
    fill(sending.bubble, { text: reply.error ? `${path} ${t("It stopped with: {error}", { error: reply.error })}` : path });
  }, [run, sending]);

  if (!isChatTrigger(draft.trigger)) return null;
  const trigger = draft.trigger;

  const send = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const said = text.trim();
    if (!said || sending) return;
    // The chat so far, customer messages and bot replies, as the conversation history the webhook would send.
    const earlier: ChatTurn[] = bubbles.filter((b) => !b.pending).map((b) => ({ direction: b.from === "customer" ? "in" : "out", text: b.text }));
    const n = next.current;
    next.current += 2;
    setBubbles((all) => [...all, { id: n, from: "customer", text: said }, { id: n + 1, from: "bot", text: "", pending: true }]);
    setText("");
    const payload = chatPayload(trigger, said, earlier, n);
    try {
      setSending({ bubble: n + 1, runId: await start(payload, "ai"), payload, mocked: false });
    } catch (err) {
      fill(n + 1, { text: (err as Error).message });
    }
  };

  return (
    <section className="t8-chat" aria-labelledby="t8-chat-title">
      <h2 id="t8-chat-title">{t("Chat as your customer")}</h2>
      <p className="muted hint">{t("Type what a customer would send. Each message is a test run with the real AI model and uses one AI action. Replies are not sent to anyone.")}</p>
      {bubbles.length > 0 && (
        <ol className="t8-chat-log" role="log" aria-live="polite" aria-label={t("Test chat")}>
          {bubbles.map((b) => (
            <li key={b.id} className={`t8-bubble is-${b.from}`} aria-busy={b.pending || undefined}>
              <span className="t8-who">{t(b.from === "customer" ? "You, as the customer" : "Your workflow")}</span>
              <span className="t8-text">{b.pending ? t("Running…") : b.text}</span>
              {b.note && <span className="t8-note">{b.note}</span>}
            </li>
          ))}
        </ol>
      )}
      <form className="t8-chat-form" onSubmit={(e) => void send(e)}>
        <label htmlFor="t8-chat-text" className="sr-only">
          {t("Message as your customer")}
        </label>
        <input id="t8-chat-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder={t("Message as your customer")} autoComplete="off" />
        <button type="submit" disabled={!!sending || text.trim() === "" || draft.steps.length === 0}>
          {t("Send")}
        </button>
      </form>
      {bubbles.length > 0 && (
        <button type="button" className="quiet" onClick={() => setBubbles([])} disabled={!!sending}>
          {t("Clear chat")}
        </button>
      )}
    </section>
  );
}
