import "./creation.css";
import { templatesForLanguage } from "@daloy/engine";
import { useLanguage } from "./Language";
import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, type Workflow } from "./api";
import { saveDraft } from "./AiDraft";
import "./ai-workspace.css";
import { approvalWanted, chatStep, connectedApps, wire, type ChatReply, type ChatState } from "./lib/ai-chat";
import { closestTemplate, draftPlan, warningForLanguage, withLabels, withPeople } from "./lib/ai-build";
import { createAiLogId, deleteAiLog, loadAiLogs, upsertAiLog, type AiConversationLog, type AiLogStatus } from "./lib/ai-logs";
import { startOfficeSetup, startPurchaseSetup } from "./OfficeRequests";
import { pushToast } from "./Toast";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

/** Step types that need a connected app, with the provider name GET /settings/connections uses. */
const NEEDS: Record<string, { provider: string; label: string }> = {
  sheets: { provider: "google_sheets", label: "Google Sheet" },
  slack: { provider: "slack", label: "Slack" },
  outlook: { provider: "outlook", label: "Outlook" },
  teams: { provider: "teams", label: "Teams" },
  drive: { provider: "google_drive", label: "Google Drive" },
  calendar: { provider: "google_calendar", label: "Google Calendar" },
  telegram: { provider: "telegram", label: "Telegram" },
  airtable: { provider: "airtable", label: "Airtable" },
  notion: { provider: "notion", label: "Notion" },
  trello: { provider: "trello", label: "Trello" },
  discord: { provider: "discord", label: "Discord" },
  google_docs: { provider: "google_drive", label: "Google Drive" },
  paymongo_link: { provider: "paymongo", label: "PayMongo" },
  meta_reply: { provider: "meta_messenger", label: "Facebook Messenger & Instagram" },
  whatsapp_reply: { provider: "whatsapp", label: "WhatsApp Cloud API" },
  shopify_create_product: { provider: "shopify", label: "Shopify" },
  shopify_update_product: { provider: "shopify", label: "Shopify" },
};
const OUTPUT: Record<string, string> = {
  approval: "Approval decision",
  condition: "Selected branch",
  email: "Email delivery",
  outlook: "Email delivery",
  slack: "Channel message",
  teams: "Channel message",
  telegram: "Chat message",
  sms: "SMS delivery",
  meta_reply: "DM reply",
  whatsapp_reply: "WhatsApp message",
  shopify_create_product: "Shopify product",
  shopify_update_product: "Shopify product update",
  ai: "AI result",
  delay: "Resume time",
  sheets: "Spreadsheet row",
  drive: "Saved file",
  http: "HTTP response",
  browser: "Values read from the page",
  booking: "Booking result",
  calendar: "Calendar event",
  paymongo_link: "Payment link",
  payment_status: "Payment status",
  airtable: "Table record",
  notion: "Database page",
  trello: "Board card",
  discord: "Channel message",
  google_docs: "Google Docs document",
  read_page: "Page text",
};
const WHY: Record<string, string> = {
  "purchase-request": "You asked for an approval first. This one asks a person you name to approve each purchase.",
  "website-inquiry": "Visitors fill in your inquiry form and get a reply from your own email address.",
  "office-request": "Staff fill in a form, each request gets a reference, and your office is told.",
};
const SETUP_LABEL: Record<string, string> = { purchase: "Set up purchase requests", office: "Set up for my office", link: "Set up inquiry replies" };

/**
 * #/ai (owners): Build with AI. The page is one chat: say what should happen, the model asks what it still needs, and
 * the draft comes back as the last message, and nothing is turned on until the owner presses Turn it on.
 */
const STARTERS = [
  { role: "Freelancer", text: "When a client fills my inquiry form, email them a thank-you and add them to my Google Sheet." },
  { role: "Small shop", text: "When a customer orders, email me the order and remind me the next day." },
  { role: "Salon", text: "When someone books an appointment, send them a reminder one day before." },
  { role: "Virtual assistant", text: "Every Monday at 9, email my client a summary of last week's requests." },
];

const FRESH: ChatState = { phase: "idle", turns: [], draft: null, error: "" };


function formatLogTime(iso: string, locale: string): string {
  try {
    const dt = new Date(iso);
    return new Intl.DateTimeFormat(locale === "tl" ? "fil-PH" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(dt);
  } catch {
    return iso;
  }
}

export function BuildWithAiPage({ email, admin = false, embedded = false }: { email: string; admin?: boolean; embedded?: boolean }) {
  const { t, language } = useLanguage();
  const [chat, dispatch] = useReducer(chatStep, FRESH);
  const { phase, turns, draft, error } = chat;
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [setupError, setSetupError] = useState("");
  const [view, setView] = useState<"describe" | "review">("describe");
  const [logId, setLogId] = useState<string>(() => createAiLogId());
  const [logs, setLogs] = useState<AiConversationLog[]>(() => loadAiLogs(email));
  const [logsOpen, setLogsOpen] = useState(false);
  const [closingLogs, setClosingLogs] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const busy = phase === "thinking" || phase === "turning-on";
  const reviewing = draft !== null && (phase === "summary" || phase === "turning-on");
  const empty = turns.length === 0;
  const showReview = reviewing && view === "review";

  useEffect(() => {
    setLogs(loadAiLogs(email));
  }, [email]);

  useEffect(() => {
    const refresh = () => api<{ connections: { provider: string; status: string }[] }>("GET", "/settings/connections").then(
      (r) => setConnected(new Set(r.connections.filter((c) => c.status === "active").map((c) => c.provider))),
      () => setConnected(new Set()),
    );
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [turns, phase]);

  useEffect(() => {
    if (turns.length === 0 && !draft) return;
    const status: AiLogStatus | undefined = phase === "on" ? "live" : phase === "error" ? "failed" : undefined;
    setLogs(upsertAiLog(email, { id: logId, turns, draft, status, error: phase === "error" ? error : undefined }));
  }, [email, logId, turns, draft, phase, error]);

  useEffect(() => {
    if (!closingLogs) return;
    const timer = window.setTimeout(() => {
      setLogsOpen(false);
      setClosingLogs(false);
    }, 240);
    return () => window.clearTimeout(timer);
  }, [closingLogs]);


  function closeLogs() {
    if (!logsOpen || closingLogs) return;
    setClosingLogs(true);
  }

  /** Only the owner's press gets here. A refused publish (an app it needs is not connected) returns to the summary. */
  async function turnOn() {
    if (!draft || phase !== "summary") return;
    dispatch({ type: "turnOn" });
    try {
      const wf = await saveDraft(draft.name, draft.definition, draft.summary, true);
      await api("PATCH", `/workflows/${wf.id}/setup`, { kind: "generated", template: "custom", step: "turnon", answers: {} }).catch(() => undefined);
      setLogs(upsertAiLog(email, { id: logId, turns, draft, status: "live" }));
      dispatch({ type: "turnedOn" });
      pushToast({ message: t("Automation turned on."), tone: "success" });
      location.hash = `#/a/${wf.id}`;
    } catch (err) {
      dispatch({ type: "failed", message: (err as Error).message });
    } finally {
      window.dispatchEvent(new Event("daloy:usage"));
    }
  }

  async function talk(text: string) {
    if (busy) return;
    dispatch({ type: "send", text });
    setInput("");
    setView("describe");
    setSaveError("");
    try {
      const reply = await api<ChatReply>("POST", "/ai/chat", {
        messages: wire([...turns, { role: "user", text }]),
        // A change request carries the draft, with the real addresses put back as labels first.
        current: draft ? withLabels(draft.definition, { owner: email }) : undefined,
        apps: connectedApps(connected),
      });
      if (reply.kind === "draft") setView("review");
      dispatch({ type: "reply", reply: reply.kind === "draft" ? { ...reply, definition: withPeople(reply.definition, { owner: email }) } : reply });
    } catch (err) {
      dispatch({ type: "failed", message: (err as Error).message });
    } finally {
      window.dispatchEvent(new Event("daloy:usage"));
    }
  }

  function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (text) void talk(text);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(e);
    }
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError("");
    try {
      const wf = await saveDraft(draft.name, draft.definition, draft.summary);
      await api("PATCH", `/workflows/${wf.id}/setup`, { kind: "generated", template: "custom", step: "questions", answers: {} }).catch(() => undefined);
      setLogs(upsertAiLog(email, { id: logId, turns, draft, status: "saved" }));
      pushToast({ message: t("Saved draft."), tone: "success" });
      location.hash = `#/a/${wf.id}`;
    } catch (err) {
      setSaveError((err as Error).message);
      setSaving(false);
    }
  }

  function describe() {
    setView("describe");
    requestAnimationFrame(() => box.current?.focus());
  }

  function startOver() {
    setView("describe");
    setLogId(createAiLogId());
    dispatch({ type: "reset" });
    setInput("");
    setSaveError("");
    setSetupError("");
    closeLogs();
    requestAnimationFrame(() => box.current?.focus());
  }

  function openLog(entry: AiConversationLog) {
    setLogId(entry.id);
    dispatch({ type: "restore", turns: entry.turns, draft: entry.draft, status: entry.status, error: entry.error });
    setInput("");
    setSaveError("");
    setSetupError("");
    setView(entry.draft ? "review" : "describe");
    closeLogs();
  }

  function removeLog(id: string) {
    const remaining = deleteAiLog(email, id);
    setLogs(remaining);
    if (id === logId) {
      setLogId(createAiLogId());
      dispatch({ type: "reset" });
      setView("describe");
    }
    pushToast({ message: t("Conversation removed."), tone: "info" });
  }

  function starter(text: string) {
    setInput(text);
    box.current?.focus();
  }

  async function useSuggestedTemplate(slug: string, fallbackName: string) {
    const item = templatesForLanguage(language).find((x) => x.slug === slug);
    if (!item) {
      location.hash = "#/new";
      return;
    }
    setSetupError("");
    try {
      const baseName = t(item.name) || fallbackName;
      const unique = `${slugify(baseName) || slug}-${Date.now().toString(36).slice(-4)}`;
      const wf = await api<Workflow>("POST", "/workflows", { name: baseName, slug: unique.slice(0, 63) });
      const ownerEmail = email.trim();
      const definition = ownerEmail
        ? {
            ...item.definition,
            steps: item.definition.steps.map((s) => {
              const cfg = s.config as Record<string, unknown>;
              const nextCfg = { ...cfg };
              if (nextCfg.to === "owner@example.com") nextCfg.to = ownerEmail;
              if (nextCfg.approver === "owner@example.com") nextCfg.approver = ownerEmail;
              return { ...s, config: nextCfg };
            }),
          }
        : item.definition;
      await api("POST", `/workflows/${wf.id}/versions`, { definition, publish: false });
      await api("PATCH", `/workflows/${wf.id}/setup`, { kind: "generated", template: slug, step: "questions", answers: {} });
      pushToast({ message: t("Created draft from template."), tone: "success" });
      location.hash = `#/a/${wf.id}`;
    } catch (e) {
      setSetupError((e as Error).message);
    }
  }

  const template = closestTemplate({ approve: approvalWanted(turns) ? "yes" : "" }, turns.find((x) => x.role === "user")?.text ?? "");
  const setup = template.action ?? "link";
  const plan = draft ? draftPlan(draft.definition, language) : null;
  const hasConversationPlan = draft !== null || turns.some((turn) => turn.role === "assistant");

  const firstRequest = turns.find((turn) => turn.role === "user")?.text;
  const lastTurn = turns.at(-1);
  const latestHasChoices = lastTurn?.role === "assistant" && (lastTurn.choices?.length ?? 0) > 0;

  const composer = (
    <form className="composer" onSubmit={send}>
      <label htmlFor="chat-text" className={empty && phase !== "error" ? "visually-hidden" : "composer-label"}>
        {draft ? t("What should change?") : t("What should happen?")}
      </label>
      <textarea
        id="chat-text"
        ref={box}
        rows={empty ? 3 : 2}
        maxLength={2000}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKey}
        placeholder={draft ? t("What should change?") : t("When someone fills my form, email them a thank-you.")}
      />
      <div className="ai-composer-foot">
        <div className="ai-composer-left">
          {phase === "asking" && !draft && !latestHasChoices && (
            <button type="button" className="ai-chip-btn" disabled={busy} onClick={() => void talk(t("Build it now with what you have."))}>
              {t("Build it now")}
            </button>
          )}
          {hasConversationPlan && (
            <button type="button" className="ai-chip-btn quiet" disabled={busy} onClick={startOver}>
              {t("Start over")}
            </button>
          )}
        </div>
        <button className="primary ai-send-btn" disabled={busy || !input.trim()}>
          {busy ? t("Working...") : t("Send")}
        </button>
      </div>
      <p className="muted hint">{t("Only your words, and which apps are connected, go to the AI. Each message uses one AI action. Nothing goes live until you press Turn it on.")}</p>
    </form>
  );

  const Wrap = embedded ? "div" : "main";
  const topbar = (
    <header className="ai-topbar">
      <div className="ai-topbar-left">
        {embedded ? <h2 className="ai-sr-title">{t("Build with AI")}</h2> : <h1 className="ai-sr-title">{t("Build with AI")}</h1>}
      </div>
      <div className="ai-topbar-right">
        {reviewing && (
          <div className="ai-view-switch" role="tablist" aria-label={t("Build with AI")}>
            <button type="button" role="tab" aria-selected={!showReview} onClick={describe}>{t("Describe")}</button>
            <button type="button" role="tab" aria-selected={showReview} onClick={() => setView("review")}>{t("Review plan")}</button>
          </div>
        )}
        <button
          type="button"
          className={`logs-toggle${logsOpen && !closingLogs ? " is-active" : ""}`}
          aria-expanded={logsOpen}
          aria-controls="ai-logs-drawer"
          onClick={() => (logsOpen ? closeLogs() : setLogsOpen(true))}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 8l0 4l2 2" />
            <path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5" />
          </svg>
          <span>{t("Conversation logs")}</span>
          {logs.length > 0 && <span className="logs-count">{logs.length}</span>}
        </button>
      </div>
    </header>
  );

  return (
    <Wrap className={`page creation-page creation-chat${embedded ? " is-embedded" : ""}${empty && phase !== "error" && !showReview ? " is-stage" : ""}`}>
      {topbar}

      {showReview && draft && plan ? (
        <section className="builder-split" aria-labelledby="review-title">
          <div className="plan-body">
            <h2 id="review-title">{t("Check the draft: {name}", { name: draft.name })}</h2>
            <p>{draft.summary}</p>
            <table className="plan-table">
              <caption className="visually-hidden">{t("Review plan")}</caption>
              <thead>
                <tr>{["Step", "Action", "App", "Output"].map((label) => <th key={label}>{t(label)}</th>)}</tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">{t("When")}</th>
                  <td>{plan.when}</td>
                  <td>{t(draft.definition.trigger.type)}</td>
                  <td>{t("Trigger data")}</td>
                </tr>
                {plan.rows.map(({ step, action }, index) => (
                  <tr key={step.id}>
                    <th scope="row">{index + 1}</th>
                    <td>{action}</td>
                    <td>{t(NEEDS[step.type]?.label ?? step.type)}</td>
                    <td>{t(OUTPUT[step.type] ?? "Run result")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3>{t("Check before turning on")}</h3>
            {draft.warnings.length ? (
              <ul>{draft.warnings.map((w) => <li key={w}>{warningForLanguage(w, language)}</li>)}</ul>
            ) : (
              <p>{t("The checker found nothing to fix.")}</p>
            )}
          </div>
          <aside className="builder-details">
            <h2>{t("Sample run")}</h2>
            <p>{plan.when}</p>
            {plan.rows[0] && (
              <>
                <h3>{t("First action")}</h3>
                <p>{plan.rows[0].action}</p>
              </>
            )}
            <h3>{t("Your request")}</h3>
            <p>{firstRequest}</p>
            <h3>{t("Apps this needs")}</h3>
            {Object.keys(NEEDS).some((kind) => draft.definition.steps.some((s) => s.type === kind)) ? (
              <ul className="list">
                {Object.entries(NEEDS)
                  .filter(([kind]) => draft.definition.steps.some((s) => s.type === kind))
                  .map(([kind, app]) => (
                    <li key={kind}>
                      {t(app.label)}: {connected.has(app.provider) ? t("Connected") : <a href="#/apps" target="_blank" rel="noopener">{t("Connect in Apps")}</a>}
                    </li>
                  ))}
              </ul>
            ) : (
              <p>{t("No apps are needed.")}</p>
            )}
            <div className="actions">
              <button type="button" disabled={saving || phase !== "summary"} onClick={() => void turnOn()}>
                {t("Turn it on")}
              </button>
              <button type="button" disabled={busy} onClick={describe}>
                {t("Change something")}
              </button>
              <button type="button" className="primary" disabled={saving || busy} onClick={save}>
                {t("Save as draft")}
              </button>
            </div>
            <p role="alert" className="message error" hidden={!saveError && !(phase === "summary" && error)}>
              {saveError || (error && `${t("It is built, but it could not be turned on: ")}${error}`)}
            </p>
          </aside>
        </section>
      ) : empty && phase !== "error" ? (
        <section className="ai-stage" aria-label={t("Turn your ideas into automations")}>
          <div className="ai-hero-head">
            <span className="ai-bot-badge" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 120 120">
                <path fill="currentColor" d="M22 18H60V56H60C39 56 22 39 22 18Z" />
                <path fill="currentColor" d="M60 56C81 56 98 73 98 94V102H60V56Z" />
                <path fill="currentColor" d="M60 18C81 18 98 35 98 56H60V18Z" opacity="0.28" />
              </svg>
            </span>
            <h2 className="ai-hero-title">{t("Turn your ideas into automations")}</h2>
          </div>
          {composer}
          {/* A few example chips under the box, as in the Console Blocks mock (decision 0164); Templates has the full list. */}
          <ul className="ai-chips" aria-label={t("Examples")}>
            {STARTERS.map((item) => (
              <li key={item.role}>
                <button type="button" className="ai-chip" title={t(item.text)} onClick={() => starter(t(item.text))}>{t(item.role)}</button>
              </li>
            ))}
            <li><a className="ai-chip" href="#/new">{t("More")}</a></li>
          </ul>
        </section>
      ) : (
        <div className="builder-split">
          <div className="describe-body">
            <h2>{t("Describe your automation")}</h2>
            <div className="ai-build">
              {!empty && (
                <section className="chat" aria-label={t("Conversation")} role="log" aria-live="polite">
                  {turns.map((turn, i) => (
                    <div key={i} className={`chat-line ${turn.role}`}>
                      {turn.role === "assistant" ? (
                        <div className="ai-turn-row">
                          <span className="ai-bot-badge sm" aria-hidden="true">
                            <svg width="15" height="15" viewBox="0 0 120 120">
                              <path fill="currentColor" d="M22 18H60V56H60C39 56 22 39 22 18Z" />
                              <path fill="currentColor" d="M60 56C81 56 98 73 98 94V102H60V56Z" />
                              <path fill="currentColor" d="M60 18C81 18 98 35 98 56H60V18Z" opacity="0.28" />
                            </svg>
                          </span>
                          <div className="ai-bot-body">
                            <div className="assistant-id">{t("AI assistant")}</div>
                            <p>{turn.text}</p>
                            {turn.choices && turn.choices.length > 0 && (
                              <div className="ai-question-card">
                                <div className="ai-question-head">
                                  <strong>{t("Pick an option or reply below")}</strong>
                                  <span className="pill blue">{t("Quick clarify")}</span>
                                </div>
                                <ul className="chat-chips" aria-label={t("Answers")}>
                                  {turn.choices.map((choice) => (
                                    <li key={choice}>
                                      <button type="button" disabled={busy} onClick={() => void talk(choice)}>
                                        {choice}
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                                {phase === "asking" && !draft && i === turns.length - 1 && (
                                  <div className="ai-question-foot">
                                    <span>{t("Uses connected apps & Knowledge automatically.")}</span>
                                    <button type="button" className="ai-chip-btn" disabled={busy} onClick={() => void talk(t("Build it now with what you have."))}>
                                      {t("Build it now")}
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <p>{turn.text}</p>
                      )}
                    </div>
                  ))}
                  {busy && (
                    <div className="chat-line assistant chat-thinking" role="status">
                      <span className="chat-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      {phase === "turning-on" ? t("Turning it on...") : t("Thinking...")}
                    </div>
                  )}
                  <div ref={bottom} />
                </section>
              )}

              {composer}

              {phase === "error" && (
                <>
                  <p role="alert" className="message error">
                    {error}
                  </p>
                  <section className="demo-card" aria-labelledby="ai-failed">
                    <h2 id="ai-failed">{t("The AI is not set up, or it did not answer.")}</h2>
                    <p>
                      {admin ? (
                        <a href="#/settings/ai">{t("Check the AI model")}</a>
                      ) : (
                        <a href="#/new">{t("Browse the template library")}</a>
                      )}
                    </p>
                    <h3>{t("The closest ready-made automation: {name}", { name: t(template.label) })}</h3>
                    <p>{t(template.reason ?? WHY[template.slug] ?? "")}</p>
                    <div className="actions">
                      {template.href ? (
                        <a href={template.href}>{t(SETUP_LABEL[setup]!)}</a>
                      ) : template.action ? (
                        <button type="button" className="primary" onClick={() => (template.action === "purchase" ? startPurchaseSetup(email, language) : startOfficeSetup(email, language)).catch((e: Error) => setSetupError(e.message))}>
                          {t(SETUP_LABEL[setup]!)}
                        </button>
                      ) : (
                        <button type="button" className="primary" onClick={() => void useSuggestedTemplate(template.slug, t(template.label))}>
                          {t("Use this template")}
                        </button>
                      )}
                    </div>
                    <p role="alert" className="message error" hidden={!setupError}>
                      {setupError}
                    </p>
                  </section>
                </>
              )}
            </div>
          </div>
          <aside className="builder-details">
            <h2>{t("Conversation details")}</h2>
            {firstRequest && (
              <>
                <h3>{t("Your request")}</h3>
                <p>{firstRequest}</p>
              </>
            )}
            {draft && (
              <>
                <h3>{draft.name}</h3>
                <p>{draft.summary}</p>
                <button disabled={!reviewing} onClick={() => setView("review")}>{t("Review plan")}</button>
              </>
            )}
          </aside>
        </div>
      )}

      {logsOpen && (
        <div className={`ai-logs-layer${closingLogs ? " is-closing" : ""}`}>
          <div className="ai-logs-backdrop" onClick={closeLogs} aria-hidden="true" />
          <aside
            id="ai-logs-drawer"
            className={`ai-logs-drawer${closingLogs ? " is-closing" : ""}`}
            aria-label={t("Conversation logs")}
            onAnimationEnd={(e) => {
              if (e.target === e.currentTarget && closingLogs) {
                setLogsOpen(false);
                setClosingLogs(false);
              }
            }}
          >
            <div className="ai-logs-head">
              <div className="ai-logs-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 8l0 4l2 2" />
                  <path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5" />
                </svg>
                <h2>{t("Conversation logs")}</h2>
              </div>
              <button type="button" className="ai-logs-close" aria-label={t("Close logs")} onClick={closeLogs}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 6l-12 12" />
                  <path d="M6 6l12 12" />
                </svg>
              </button>
            </div>
            <button type="button" className="ai-logs-new" onClick={startOver}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5l0 14" />
                <path d="M5 12l14 0" />
              </svg>
              <span>{t("New conversation")}</span>
            </button>
            {logs.length === 0 ? (
              <p className="ai-logs-empty">{t("No conversations yet.")}</p>
            ) : (
              <ul className="ai-logs-list">
                {logs.map((entry) => {
                  const statusLabel =
                    entry.status === "live"
                      ? t("Live")
                      : entry.status === "saved"
                        ? t("Saved")
                        : entry.status === "failed"
                          ? t("Failed")
                          : t("In progress");
                  return (
                    <li key={entry.id} className={`ai-log-item${entry.id === logId ? " is-current" : ""}`}>
                      <button type="button" className="ai-log-open" onClick={() => openLog(entry)}>
                        <span className="ai-log-title">{entry.title}</span>
                        <span className="ai-log-meta">
                          <span className={`ai-log-badge is-${entry.status}`}>{statusLabel}</span>
                          <span>{formatLogTime(entry.updatedAt, language)}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="ai-log-delete"
                        aria-label={t("Delete conversation")}
                        onClick={() => removeLog(entry.id)}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 7l16 0" />
                          <path d="M10 11l0 6" />
                          <path d="M14 11l0 6" />
                          <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" />
                          <path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" />
                        </svg>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </div>
      )}
    </Wrap>
  );
}
