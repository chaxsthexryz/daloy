import "./creation.css";
import { useLanguage } from "./Language";
import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api } from "./api";
import { saveDraft } from "./AiDraft";
import "./ai-workspace.css";
import { approvalWanted, chatStep, connectedApps, wire, type ChatReply, type ChatState } from "./lib/ai-chat";
import { closestTemplate, draftPlan, warningForLanguage, withLabels, withPeople } from "./lib/ai-build";
import { Header } from "./Nav";
import { startOfficeSetup, startPurchaseSetup } from "./OfficeRequests";

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
  payment_status: { provider: "paymongo", label: "PayMongo" },
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

export function BuildWithAiPage({ email }: { email: string }) {
  const { t, language } = useLanguage();
  const [chat, dispatch] = useReducer(chatStep, FRESH);
  const { phase, turns, draft, error } = chat;
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [setupError, setSetupError] = useState("");
  const [view, setView] = useState<"describe" | "review">("describe");
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const busy = phase === "thinking" || phase === "turning-on";
  const reviewing = draft !== null && (phase === "summary" || phase === "turning-on");

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
    // The composer is sticky at the bottom, so scroll the page to its end to keep the newest message above it.
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [turns, phase]);

  /** Only the owner's press gets here. A refused publish (an app it needs is not connected) returns to the summary. */
  async function turnOn() {
    if (!draft || phase !== "summary") return;
    dispatch({ type: "turnOn" });
    try {
      const wf = await saveDraft(draft.name, draft.definition, draft.summary, true);
      dispatch({ type: "turnedOn" });
      location.hash = `#/w/${wf.id}`;
    } catch (err) {
      dispatch({ type: "failed", message: (err as Error).message });
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
      location.hash = `#/w/${wf.id}`;
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
    dispatch({ type: "reset" });
    setInput("");
    setSaveError("");
    setSetupError("");
    box.current?.focus();
  }

  function starter(text: string) {
    setInput(text);
    box.current?.focus();
  }

  const empty = turns.length === 0;
  const template = closestTemplate({ approve: approvalWanted(turns) ? "yes" : "" }, turns.find((x) => x.role === "user")?.text ?? "");
  const setup = template.action ?? "link";
  const plan = draft ? draftPlan(draft.definition, language) : null;

  const showReview = reviewing && view === "review";
  const firstRequest = turns.find(turn => turn.role === "user")?.text;
  const composer = (
    <form className="composer" onSubmit={send}>
      <label htmlFor="chat-text" className="composer-label">
        {draft ? t("What should change?") : t("What should happen?")}
      </label>
      <textarea
        id="chat-text"
        ref={box}
        rows={empty ? 4 : 2}
        maxLength={2000}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKey}
        placeholder={draft ? t("What should change?") : t("When someone fills my form, email them a thank-you.")}
      />
      <div className="actions">
        <button className="primary" disabled={busy || !input.trim()}>
          {busy ? t("Working...") : t("Send")}
        </button>
        {turns.length > 0 && !draft && (
          <button type="button" disabled={busy} onClick={() => void talk(t("Build it now with what you have."))}>
            {t("Build it now")}
          </button>
        )}
        {turns.length > 0 && (
          <button type="button" className="quiet" disabled={busy} onClick={startOver}>
            {t("Start over")}
          </button>
        )}
      </div>
      <p className="muted hint">{t("Only your words, and which apps are connected, go to the AI. Each message uses one AI action. Nothing goes live until you press Turn it on.")}</p>
    </form>
  );

  return (
    <main className="page creation-page creation-chat">
      <header className="builder-head"><a href="#/">{t("Automations")}</a><Header title={t("Build with AI")} />
        <nav className="builder-tabs" aria-label={t("Build with AI")}>
          <button aria-current={!showReview ? "page" : undefined} onClick={describe}>{t("Describe")}</button>
          <button aria-current={showReview ? "page" : undefined} disabled={!reviewing} onClick={() => setView("review")}>{t("Review plan")}</button>
        </nav>
      </header>
      {showReview && draft && plan ? (
        <section className="builder-split" aria-labelledby="review-title">
          <div className="plan-body"><h2 id="review-title">{t("Check the draft: {name}", { name: draft.name })}</h2><p>{draft.summary}</p>
            <table className="plan-table"><caption className="visually-hidden">{t("Review plan")}</caption><thead><tr>{["Step", "Action", "App", "Output"].map(label => <th key={label}>{t(label)}</th>)}</tr></thead>
              <tbody><tr><th scope="row">{t("When")}</th><td>{plan.when}</td><td>{t(draft.definition.trigger.type)}</td><td>{t("Trigger data")}</td></tr>
                {plan.rows.map(({ step, action }, index) => <tr key={step.id}><th scope="row">{index + 1}</th><td>{action}</td><td>{t(NEEDS[step.type]?.label ?? step.type)}</td><td>{t(OUTPUT[step.type] ?? "Run result")}</td></tr>)}
              </tbody>
            </table>
            <h3>{t("Check before turning on")}</h3>
            {draft.warnings.length ? <ul>{draft.warnings.map(w => <li key={w}>{warningForLanguage(w, language)}</li>)}</ul> : <p>{t("The checker found nothing to fix.")}</p>}
          </div>
          <aside className="builder-details"><h2>{t("Sample run")}</h2><p>{plan.when}</p>{plan.rows[0] && <><h3>{t("First action")}</h3><p>{plan.rows[0].action}</p></>}<h3>{t("Your request")}</h3><p>{firstRequest}</p>
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
      ) : <div className="builder-split"><div className="describe-body"><h2>{t("Describe your automation")}</h2>
      <div className={`ai-build${empty ? " ai-empty" : ""}`}>
        {!empty && (
          <section className="chat" aria-label={t("Conversation")} role="log" aria-live="polite">
            {turns.map((turn, i) => (
              <div key={i} className={`chat-line ${turn.role}`}>
                {turn.role === "assistant" && <div className="assistant-id"><img src="/grok.svg" alt="" />{t("AI assistant")}</div>}
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
          </>
        )}
      </div></div><aside className="builder-details"><h2>{t("Conversation details")}</h2>
        {firstRequest && <><h3>{t("Your request")}</h3><p>{firstRequest}</p></>}
        {draft && <><h3>{draft.name}</h3><p>{draft.summary}</p><button disabled={!reviewing} onClick={() => setView("review")}>{t("Review plan")}</button></>}
        {empty && <><h3>{t("Examples")}</h3>
          <ul className="demo-starters ai-starters" aria-label={t("Examples")}>
            {STARTERS.map((x) => (
              <li key={x.role}>
                <button type="button" onClick={() => starter(t(x.text))}>
                  <strong>{t(x.role)}</strong>
                  <span className="muted">{t(x.text)}</span>
                </button>
              </li>
            ))}
          </ul></>}
      </aside></div>}
    </main>
  );
}
