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

/** Send feedback (A4): any role writes to the operator and sees this workspace's earlier messages with the replies. */
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
          <Breadcrumb items={backToRequests ? [{ label: t("My requests"), href: "#/" }, { label: t("Send feedback") }] : [{ label: t("Home"), href: "#/" }, { label: t("Send feedback") }]} />
          <div className="wk-title-row"><h1>{t("Send feedback")}</h1></div>
        </div>
      </header>
      <section className="wk-card wk-narrow" aria-labelledby="feedback-new">
        <h2 className="wk-card-head" id="feedback-new"><b>{t("Tell us what you think")}</b></h2>
        <form className="wk-body wk-fields" onSubmit={submit}>
          <div>
            <label htmlFor="feedback-topic">{t("Topic")}</label>
            <select id="feedback-topic" name="topic" defaultValue="idea">
              {TOPICS.map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="feedback-message">{t("Message")} <span className="wk-muted">{t("(up to 2,000 characters)")}</span></label>
            <textarea id="feedback-message" name="message" rows={5} maxLength={MAX} required />
          </div>
          <p role="status" className="wk-note ok" hidden={!sent}>{sent && t("Thank you. Your message was sent.")}</p>
          <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
          <button className="wk-button blue" disabled={busy}>{t("Send")}</button>
        </form>
      </section>
      <section className="wk-card wk-narrow" aria-labelledby="feedback-past">
        <h2 className="wk-card-head" id="feedback-past"><b>{t("Your messages")}</b></h2>
        <div className="wk-body">
          {items === null ? <p className="wk-muted">{t("Loading…")}</p> : items.length === 0 ? <p className="wk-muted">{t("None yet.")}</p> : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 16 }}>
              {items.map((i) => (
                <li key={i.id}>
                  <p><b>{t(TOPICS.find(([id]) => id === i.topic)?.[1] ?? "Other")}</b> <span className="wk-muted">{sentOn(i.createdAt, language)} · {t(STATUS[i.status] ?? i.status)}</span></p>
                  <p style={{ whiteSpace: "pre-wrap" }}>{i.message}</p>
                  {i.reply && <p style={{ whiteSpace: "pre-wrap" }}><b>{t("Reply")}:</b> {i.reply}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
