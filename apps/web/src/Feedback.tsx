import "./workspace-admin.css";
import "./workspace.css";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { Breadcrumb } from "./Breadcrumb";
import { useLanguage } from "./Language";
import { sentOn } from "./lib/my-requests";

const TOPICS = [["bug", "Bug"], ["idea", "Idea"], ["question", "Question"], ["billing", "Billing"], ["other", "Other"]] as const;
const STATUS: Record<string, string> = { new: "Waiting for a reply", replied: "Replied", closed: "Closed" };
const MAX = 2000;

type Item = { id: string; topic: string; message: string; status: string; reply: string | null; createdAt: string; repliedAt: string | null };

const FAQS = [
  {
    q: "How do GCash receipt checks work?",
    a: "When a guest uploads a screenshot, kymavo extracts the amount and reference number and sends it to Inbox. Confirm only after checking your own GCash or bank history.",
    defaultOpen: true,
  },
  {
    q: "Why did Google Drive show Needs attention?",
    a: "OAuth tokens expire when permissions change or passwords reset. Open Apps in Business, select Google Drive, and reconnect your account.",
  },
  {
    q: "What happens during the 24-hour Messenger window?",
    a: "Replies inside Messenger work automatically within 24 hours of the guest's last message. Past 24 hours, kymavo flags the conversation in Inbox.",
  },
  {
    q: "How do I upgrade or change my plan?",
    a: "Send feedback below or message your operator directly. Monthly plans are settled via GCash or Maya with no card required.",
  },
] as const;

const PATCH_NOTES = [
  {
    version: "v2.4",
    date: "Nov 28, 2026",
    badge: "Latest",
    cls: "blue",
    notes: [
      "Interactive hover breakdown added directly on Today's What ran 7-day chart and Health ring.",
      "Workflow Editor side panel toggles with Escape, with auto-saved Ask the AI conversation notes.",
      "Streamlined Workflow Editor side panel directly to Try a sample and live checks.",
    ],
  },
  {
    version: "v2.3",
    date: "Nov 20, 2026",
    badge: "Improved",
    cls: "ok",
    notes: [
      "Rebuilt Workflow Editor into an orthogonal 2D branching DAG with approved and rejected path pills.",
      "Upgraded Console Blocks shell with Geist typography, Quick jump search, and separated queue cards.",
      "Combined FAQ, Feedback, and release updates into one Support hub.",
    ],
  },
  {
    version: "v2.2",
    date: "Nov 12, 2026",
    badge: "New",
    cls: "neutral",
    notes: [
      "Launched Build with AI chat composer with quick clarify options and auto-saved Conversation logs.",
      "Added owner business setup, Inbox conversation handoff bar, and connected app status cards.",
    ],
  },
] as const;

/** Unified Support hub (FAQ, direct feedback with history, and patch notes) matching Console Blocks. */
export function FeedbackPage({ backToRequests }: { backToRequests?: boolean }) {
  const { t, language } = useLanguage();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => api<{ items: Item[] }>("GET", "/support/feedback").then((r) => setItems(r.items), (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setError("");
    setSent(false);
    setBusy(true);
    try {
      await api("POST", "/support/feedback", { topic: data.get("topic"), message: String(data.get("message")).trim() });
      form.reset();
      setSent(true);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return (
    <main className="page wk wk-account">
      <header className="wk-head">
        <div>
          <Breadcrumb items={backToRequests ? [{ label: t("My requests"), href: "#/" }, { label: t("Support") }] : [{ label: t("Home"), href: "#/" }, { label: t("Support") }]} />
          <div className="wk-title-row"><h1>{t("Support")}</h1></div>
          <p className="wk-sub">{t("Quick answers, direct feedback, and console updates.")}</p>
        </div>
        <span className="pill ok"><i className="dot" aria-hidden="true" />{t("All systems operational")}</span>
      </header>

      <div className="support-grid">
        <div className="wk-col">
          <section className="wk-card" aria-labelledby="support-faq">
            <h2 className="wk-card-head" id="support-faq"><b>{t("Frequently asked questions")}</b></h2>
            <div className="wk-body faq-list">
              {FAQS.map((item) => (
                <details key={item.q} className="faq-item" open={"defaultOpen" in item ? item.defaultOpen : false}>
                  <summary>{t(item.q)}</summary>
                  <p>{t(item.a)}</p>
                </details>
              ))}
            </div>
          </section>

          <section className="wk-card" aria-labelledby="feedback-new">
            <h2 className="wk-card-head" id="feedback-new">
              <b>{t("Send feedback")}</b>
              <span>{t("Tell us what you think")}</span>
            </h2>
            <form className="wk-body wk-fields" onSubmit={submit}>
              <div>
                <label htmlFor="feedback-topic">{t("Topic")}</label>
                <select id="feedback-topic" name="topic" defaultValue="idea">
                  {TOPICS.map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="feedback-message">{t("Message")} <span className="wk-muted">{t("(up to 2,000 characters)")}</span></label>
                <textarea id="feedback-message" name="message" rows={4} maxLength={MAX} required />
              </div>
              <p role="status" className="wk-note ok" hidden={!sent}>{sent && t("Thank you. Your message was sent.")}</p>
              <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
              <button className="wk-button blue" disabled={busy}>{t("Send")}</button>
            </form>
          </section>

          <section className="wk-card" aria-labelledby="feedback-past">
            <h2 className="wk-card-head" id="feedback-past"><b>{t("Your messages")}</b></h2>
            <div className="wk-body">
              {items === null ? <p className="wk-muted">{t("Loading…")}</p> : items.length === 0 ? <p className="wk-muted">{t("None yet.")}</p> : (
                <ul className="wk-fb-list">
                  {items.map((i) => (
                    <li key={i.id} className="wk-fb-item">
                      <div className="wk-fb-head">
                        <p><b>{t(TOPICS.find(([id]) => id === i.topic)?.[1] ?? "Other")}</b> <span className="wk-muted">{sentOn(i.createdAt, language)}</span></p>
                        <span className={`pill ${i.status === "new" ? "warn" : i.status === "replied" ? "ok" : "neutral"}`}>{t(STATUS[i.status] ?? i.status)}</span>
                      </div>
                      <p style={{ whiteSpace: "pre-wrap" }}>{i.message}</p>
                      {i.reply && <p className="wk-fb-reply" style={{ whiteSpace: "pre-wrap" }}><b>{t("Reply")}:</b> {i.reply}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <section className="wk-card" aria-labelledby="support-updates">
          <h2 className="wk-card-head" id="support-updates">
            <b>{t("Patch notes & updates")}</b>
            <span className="pill blue">v2.4</span>
          </h2>
          <div className="wk-body patch-list">
            {PATCH_NOTES.map((p) => (
              <article key={p.version} className="patch-item">
                <div className="patch-head">
                  <div className="patch-ver">
                    <strong className="mono">{p.version}</strong>
                    <span className={`pill ${p.cls}`}>{t(p.badge)}</span>
                  </div>
                  <span className="patch-date">{p.date}</span>
                </div>
                <ul className="patch-notes">
                  {p.notes.map((n) => <li key={n}>{t(n)}</li>)}
                </ul>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
