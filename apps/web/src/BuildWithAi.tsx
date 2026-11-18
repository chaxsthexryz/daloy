import { useLanguage } from "./Language";
import type { WorkflowDefinition } from "@daloy/engine";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { saveDraft } from "./AiDraft";
import { PlanList } from "./AiFlow";
import { approvalWanted, connectedApps, wire, type Draft, type Turn } from "./lib/ai-chat";
import { closestTemplate, plainDraft, withLabels, withPeople } from "./lib/ai-build";
import { AskRequest } from "./AskRequest";
import { Header } from "./Nav";
import { startOfficeSetup, startPurchaseSetup } from "./OfficeRequests";

type Reply =
  | { kind: "question"; text: string; choices: string[] }
  | { kind: "draft"; name: string; summary: string; definition: WorkflowDefinition; warnings: string[] };

/** Step types that need a connected app, with the provider name GET /settings/connections uses. */
const NEEDS: Record<string, { provider: string; label: string }> = {
  sheets: { provider: "google_sheets", label: "Google Sheet" },
  slack: { provider: "slack", label: "Slack" },
  outlook: { provider: "outlook", label: "Outlook" },
  teams: { provider: "teams", label: "Teams" },
};
const WHY: Record<string, string> = {
  "purchase-request": "You asked for an approval first. This one asks a person you name to approve each purchase.",
  "website-inquiry": "Visitors fill in your inquiry form and get a reply from your own email address.",
  "office-request": "Staff fill in a form, each request gets a reference, and your office is told.",
};
const SETUP_LABEL: Record<string, string> = { purchase: "Set up purchase requests", office: "Set up for my office", link: "Set up inquiry replies" };

/**
 * #/ai (owners): Build with AI. The page is one chat: say what should happen, the model asks what it still needs, and
 * a draft the checker finds nothing wrong with is turned on straight away (decision 0048).
 */
export function BuildWithAiPage({ email, ask = false }: { email: string; ask?: boolean }) {
  const { t, language } = useLanguage();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState("");
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  const [connected, setConnected] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [setupError, setSetupError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api<{ connections: { provider: string; status: string }[] }>("GET", "/settings/connections").then(
      (r) => setConnected(new Set(r.connections.filter((c) => c.status === "active").map((c) => c.provider))),
      () => setConnected(new Set()),
    );
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [turns, busy, draft]);

  /** Creates the workflow and turns it on. A refused publish (an app it needs is not connected) leaves the draft here. */
  async function deploy(next: Draft) {
    setDeploying(true);
    setDeployError("");
    try {
      const wf = await saveDraft(next.name, next.definition, next.summary, true);
      location.hash = `#/w/${wf.id}`;
    } catch (err) {
      setDeployError((err as Error).message);
      setDeploying(false);
    }
  }

  async function talk(text: string) {
    const next: Turn[] = [...turns, { role: "user", text }];
    setTurns(next);
    setInput("");
    setBusy(true);
    setError("");
    setDeployError("");
    setSaveError("");
    try {
      const reply = await api<Reply>("POST", "/ai/chat", {
        messages: wire(next),
        // A change request carries the draft, with the real addresses put back as labels first.
        current: draft ? withLabels(draft.definition, { owner: email }) : undefined,
        apps: connectedApps(connected),
      });
      if (reply.kind === "question") {
        setTurns([...next, { role: "assistant", text: reply.text, choices: reply.choices }]);
      } else {
        const made: Draft = { name: reply.name, summary: reply.summary, definition: withPeople(reply.definition, { owner: email }), warnings: reply.warnings };
        setDraft(made);
        setTurns([...next, { role: "assistant", text: reply.summary }]);
        setFailed(false);
        // All good means it turns itself on. A warning or a missing app keeps it here for a person to look at.
        if (made.warnings.length === 0) await deploy(made);
      }
    } catch (err) {
      setError((err as Error).message);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (text && !busy && !deploying) void talk(text);
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError("");
    try {
      const wf = await saveDraft(draft.name, draft.definition, draft.summary);
      location.hash = `#/w/${wf.id}`;
    } catch (err) {
      setSaveError((err as Error).message);
      setSaving(false);
    }
  }

  function startOver() {
    setTurns([]);
    setInput("");
    setDraft(null);
    setError("");
    setFailed(false);
    setDeployError("");
    setSaveError("");
    setSetupError("");
    box.current?.focus();
  }

  const empty = turns.length === 0 && !draft;
  const template = closestTemplate({ approve: approvalWanted(turns) ? "yes" : "" }, turns.find((x) => x.role === "user")?.text ?? "");
  const setup = template.action ?? "link";

  const composer = (
    <form className="composer" onSubmit={send}>
      <label htmlFor="chat-text" className="sr-only">
        {draft ? t("What should change?") : t("What should happen?")}
      </label>
      <textarea
        id="chat-text"
        ref={box}
        rows={empty ? 4 : 2}
        maxLength={2000}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={draft ? t("What should change?") : t("When someone fills my form, email them a thank-you.")}
      />
      <div className="actions">
        <button className="primary" disabled={busy || deploying || !input.trim()}>
          {busy || deploying ? t("Working...") : t("Send")}
        </button>
        {turns.length > 0 && !draft && (
          <button type="button" disabled={busy} onClick={() => void talk(t("Build it now with what you have."))}>
            {t("Build it now")}
          </button>
        )}
        {turns.length > 0 && (
          <button type="button" className="quiet" onClick={startOver}>
            {t("Start over")}
          </button>
        )}
      </div>
      <p className="muted hint">
        {draft
          ? t("Say what to change, and it rewrites the draft.")
          : t("Only your words, and which apps are connected, go to the AI. Each message uses one AI action. A draft with nothing to fix is turned on for you.")}
      </p>
    </form>
  );

  return (
    <main className="page">
      <Header title={t("Build with AI")} />
      <div className={`ai-build${empty ? " ai-empty" : ""}`}>
        {!empty && (
          <section className="chat" aria-label={t("Conversation")} role="log" aria-live="polite">
            {turns.map((turn, i) => (
              <div key={i} className={`chat-line ${turn.role}`}>
                <p>{turn.text}</p>
                {turn.choices && turn.choices.length > 0 && (
                  <ul className="chat-chips" aria-label={t("Answers")}>
                    {turn.choices.map((choice) => (
                      <li key={choice}>
                        <button type="button" disabled={busy} onClick={() => void talk(choice)}>
                          {choice}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {(busy || deploying) && (
              <div className="chat-line assistant chat-thinking" role="status">
                <span className="chat-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {deploying ? t("Turning it on...") : t("Thinking...")}
              </div>
            )}
            <div ref={bottom} />
          </section>
        )}

        {composer}

        {error && (
          <p role="alert" className="message error">
            {error}
          </p>
        )}
        {deployError && (
          <p role="alert" className="message error">
            {t("It is built, but it could not be turned on: ")}
            {deployError}
          </p>
        )}

        {failed && (
          <section className="demo-card" aria-labelledby="ai-failed">
            <h2 id="ai-failed">{t("The AI is not set up, or it did not answer.")}</h2>
            <p>
              <a href="#/settings/ai">{t("Check the AI model")}</a>
            </p>
            <h3>{t("The closest ready-made automation: {name}", { name: t(template.label) })}</h3>
            <p>{t(WHY[template.slug] ?? "")}</p>
            <div className="actions">
              {template.href ? (
                <a href={template.href}>{t(SETUP_LABEL[setup]!)}</a>
              ) : (
                <button type="button" className="primary" onClick={() => (template.action === "purchase" ? startPurchaseSetup(email, language) : startOfficeSetup(email, language)).catch((e: Error) => setSetupError(e.message))}>
                  {t(SETUP_LABEL[setup]!)}
                </button>
              )}
            </div>
            <p role="alert" className="message error" hidden={!setupError}>
              {setupError}
            </p>
          </section>
        )}

        {draft && (
          <section className="demo-card demo-review" aria-labelledby="review-title">
            <h2 id="review-title">{t("Check the draft: {name}", { name: draft.name })}</h2>
            <p>{draft.summary}</p>
            <PlanList lead={plainDraft(draft.definition, language).when} steps={plainDraft(draft.definition, language).steps} warnings={draft.warnings} cleanNote="The checker found nothing to fix." />
            <h3>{t("Apps this needs")}</h3>
            {Object.keys(NEEDS).some((kind) => draft.definition.steps.some((s) => s.type === kind)) ? (
              <ul className="list">
                {Object.entries(NEEDS)
                  .filter(([kind]) => draft.definition.steps.some((s) => s.type === kind))
                  .map(([kind, app]) => (
                    <li key={kind}>
                      {t(app.label)}: {connected.has(app.provider) ? t("Connected") : <a href="#/apps">{t("Connect in Apps")}</a>}
                    </li>
                  ))}
              </ul>
            ) : (
              <p>{t("No apps are needed.")}</p>
            )}
            <div className="actions">
              <button type="button" className="primary" disabled={saving || deploying} onClick={() => void deploy(draft)}>
                {t("Turn it on")}
              </button>
              <button type="button" disabled={saving} onClick={save}>
                {t("Save as draft")}
              </button>
              <button type="button" onClick={() => box.current?.focus()}>
                {t("Change something")}
              </button>
            </div>
            <p role="alert" className="message error" hidden={!saveError}>
              {saveError}
            </p>
          </section>
        )}

        {ask && empty && <AskRequest />}
      </div>
    </main>
  );
}
