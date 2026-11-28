import { useEffect, useState } from "react";
import { api } from "./api";
import { useLanguage } from "./Language";
import { shortDateTime } from "./lib/advanced";
import { tabHref } from "./lib/admin-route";

export type Feedback = { id: string; workspaceId: string; workspaceName?: string | null; senderEmail: string; topic: string; message: string; status: "new" | "replied" | "closed"; reply: string | null; createdAt: string; repliedAt: string | null };
const TOPICS: Record<string, string> = { bug: "Bug", idea: "Idea", question: "Question", billing: "Billing", other: "Other" };
const STATUS: Record<string, string> = { new: "New", replied: "Replied", closed: "Closed" };
const FILTERS = [["", "All"], ["new", "New"], ["replied", "Replied"], ["closed", "Closed"]] as const;

/** Feedback from workspaces (A4, decision 0153): read, reply (emailed to the sender) and close. */
export function AdminFeedbackTab({ status, onChanged, onError }: { status: string; onChanged: () => void; onError: (e: unknown) => void }) {
  const { t } = useLanguage();
  const filter = FILTERS.some(([k]) => k === status) ? status : "";
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => api<{ items: Feedback[] }>("GET", `/admin/feedback${filter ? `?status=${filter}` : ""}`).then((r) => setItems(r.items), onError);
  useEffect(() => {
    setItems(null);
    void load();
  }, [filter]);
  const changed = () => {
    void load();
    onChanged();
  };
  return (
    <section className="wk-card" aria-label={t("Feedback")}>
      <div className="wk-card-head ad-toolbar">
        <b>{items === null ? t("Feedback") : t("{count} messages", { count: items.length })}</b>
        <nav className="ad-seg" aria-label={t("Filter feedback")}>
          {FILTERS.map(([k, l]) => (
            <a key={k} className="wk-button" href={tabHref("feedback", k ? { status: k } : undefined)} aria-current={k === filter ? "page" : undefined}>{t(l)}</a>
          ))}
        </nav>
      </div>
      {items === null ? (
        <p className="wk-body wk-sub" role="status">{t("Loading…")}</p>
      ) : items.length === 0 ? (
        <p className="wk-body wk-sub">{t("None yet.")}</p>
      ) : (
        <ul className="ad-fb">
          {items.map((f) => <FeedbackItem key={`${f.id}:${f.status}`} item={f} open={open === f.id} onToggle={() => setOpen(open === f.id ? null : f.id)} onChanged={changed} />)}
        </ul>
      )}
    </section>
  );
}

function FeedbackItem({ item, open, onToggle, onChanged }: { item: Feedback; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const { t } = useLanguage();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const who = item.workspaceName || item.senderEmail;
  const act = async (path: "reply" | "close") => {
    setBusy(true);
    setError("");
    try {
      await api("PUT", `/admin/feedback/${item.id}/${path}`, path === "reply" ? { reply: reply.trim() } : undefined);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <li>
      <button type="button" className="ad-fb-row" aria-expanded={open} aria-controls={`fb-${item.id}`} onClick={onToggle}>
        <span className="ad-fb-main"><b>{who}</b><span>{item.message}</span></span>
        <span className="wk-chip">{t(TOPICS[item.topic] ?? item.topic)}</span>
        <span className={`pill ${item.status === "new" ? "warn" : item.status === "replied" ? "ok" : "neutral"}`}>{t(STATUS[item.status] ?? item.status)}</span>
        <span className="wk-muted">{shortDateTime(item.createdAt)}</span>
      </button>
      {open && (
        <div className="ad-fb-detail" id={`fb-${item.id}`}>
          <p className="ad-fb-message">{item.message}</p>
          <p className="wk-muted">{t("From {email}", { email: item.senderEmail })}{item.workspaceName ? `, ${item.workspaceName}` : ""}</p>
          {item.reply && (
            <div className="ad-fb-reply">
              <b>{t("Your reply")}{item.repliedAt ? `, ${shortDateTime(item.repliedAt)}` : ""}</b>
              <p>{item.reply}</p>
            </div>
          )}
          {item.status !== "closed" && (
            <form onSubmit={(e) => { e.preventDefault(); void act("reply"); }} className="ad-form">
              <label>
                {t("Reply to {who}", { who })}
                <textarea rows={3} maxLength={2000} required value={reply} onChange={(e) => setReply(e.target.value)} />
              </label>
              <div className="ad-actions">
                <button className="wk-button blue" disabled={busy || !reply.trim()}>{t("Send reply")}</button>
                <button type="button" className="wk-button" disabled={busy} onClick={() => void act("close")}>{t("Close")}</button>
              </div>
            </form>
          )}
          <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
        </div>
      )}
    </li>
  );
}
