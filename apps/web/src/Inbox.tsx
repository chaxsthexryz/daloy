import "./activity.css";
import "./inbox.css";
import { useEffect, useState } from "react";
import { api } from "./api";
import { useLanguage } from "./Language";
import { LIVE_RUN_EVENT } from "./lib/live-runs";
import { peso } from "./Receipts";
import { PageHead } from "./Runs";
import { Sheet, usePhone } from "./Sheet";
import type { User } from "./Team";
import { pushToast } from "./Toast";
import { channelLabel, type ConversationSummary } from "./lib/conversations";

type FilterKind = "all" | "conversation" | "receipt" | "approval" | "run";

type ReceiptData = {
  type: "claim" | "reply";
  claimId: string | null;
  version: number | null;
  dueId: string;
  reference: string;
  bookingReference: string | null;
  kind: "deposit" | "full" | "balance";
  amountDue: number;
  submitted: number | null;
  transferRef: string | null;
  channel: string;
  flags: string[];
  status: string;
  dueStatus: string;
  reviewer: string | null;
  hasImage: boolean;
  replyState: string | null;
  replyError: string | null;
  createdAt: string;
};

type ApprovalData = {
  id: string;
  runId: string;
  workflowId: string;
  workflowName: string;
  reference: string | null;
  stepId: string;
  message: string;
  approverId: string | null;
  approverEmail: string | null;
  canDecide: boolean;
  expiresAt: string;
  createdAt: string;
};

type ReviewRunData = {
  id: string;
  workflowId: string;
  workflowName: string;
  reference: string | null;
  state: string;
  deliveryNeedsReview: boolean;
  error: string | null;
  createdAt: string;
};

type InboxItem =
  | { id: string; kind: "conversation"; title: string; subtitle: string; createdAt: string; data: ConversationSummary }
  | { id: string; kind: "receipt"; title: string; subtitle: string; createdAt: string; data: ReceiptData }
  | { id: string; kind: "approval"; title: string; subtitle: string; createdAt: string; data: ApprovalData }
  | { id: string; kind: "run"; title: string; subtitle: string; createdAt: string; data: ReviewRunData };

type InboxPayload = {
  counts: { total: number; conversations: number; receipts: number; approvals: number; runs: number };
  items: InboxItem[];
};

type ConvoMessages = {
  messages: { id: string; direction: "in" | "out" | "staff"; text: string; createdAt: string }[];
};

const KIND_LABELS: Record<InboxItem["kind"], string> = {
  conversation: "Conversation",
  receipt: "Receipt",
  approval: "Approval",
  run: "Needs check",
};

const FLAG_LABELS: Record<string, string> = {
  duplicate_reference: "Reference used before",
  amount_mismatch: "Amount differs",
  unreadable_upload: "Upload not readable",
  already_confirmed: "Already confirmed",
  paid_twice: "Paid twice",
  late_payment: "Paid after the deadline",
};

function relativeAge(iso: string, t: (s: string, v?: Record<string, string | number>) => string) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return t("{n} min", { n: mins });
  if (mins < 48 * 60) return t("{n} h", { n: Math.round(mins / 60) });
  return t("{n} days", { n: Math.round(mins / 1440) });
}

/** #/inbox (G4): single queue for conversations waiting on staff, receipts to review, pending approvals and needs-check runs. */
export function InboxPage({ user }: { user: User }) {
  const { t } = useLanguage();
  const phone = usePhone();
  const [data, setData] = useState<InboxPayload | null>(null);
  const [filter, setFilter] = useState<FilterKind>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [messages, setMessages] = useState<ConvoMessages["messages"] | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    try {
      const next = await api<InboxPayload>("GET", "/inbox");
      setData(next);
      setError("");
      setSelectedId((prev) => (prev && next.items.some((i) => i.id === prev) ? prev : next.items[0]?.id ?? null));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener(LIVE_RUN_EVENT, refresh);
    return () => window.removeEventListener(LIVE_RUN_EVENT, refresh);
  }, []);

  const visible = (data?.items ?? []).filter((item) => filter === "all" || item.kind === filter);
  const chosen = visible.find((i) => i.id === selectedId) ?? visible[0] ?? null;

  useEffect(() => {
    if (!chosen || chosen.kind !== "conversation") {
      setMessages(null);
      return;
    }
    let active = true;
    api<ConvoMessages>("GET", `/conversations/${chosen.data.id}`)
      .then((res) => active && setMessages(res.messages))
      .catch(() => active && setMessages([]));
    return () => {
      active = false;
    };
  }, [chosen?.id]);

  const perform = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const msg = await fn();
      if (msg) {
        setNotice(msg);
        pushToast({ id: "inbox-action", message: msg, tone: "success" });
      }
      setReason("");
      setSheetOpen(false);
      await load();
      window.dispatchEvent(new Event("daloy:inbox"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const renderDetail = (item: InboxItem) => {
    if (item.kind === "conversation") {
      const c = item.data;
      return (
        <div className="ib-detail">
          <div className="ib-item-top">
            <span className="ib-kind" data-kind="conversation">{t("Conversation")}</span>
            <span className="ib-age">{channelLabel(c.channel)}</span>
          </div>
          <h2>{item.title}</h2>
          <p className="act-muted">
            {c.paused ? t("Paused for staff reply.") : t("Bot active.")}
            {c.fields.phone ? ` · ${c.fields.phone}` : ""}
            {c.fields.email ? ` · ${c.fields.email}` : ""}
          </p>
          {messages === null ? (
            <p className="act-muted">{t("Loading…")}</p>
          ) : messages.length === 0 ? (
            <p className="act-muted">{t("No messages recorded yet.")}</p>
          ) : (
            <ul className="ib-thread">
              {messages.slice(-8).map((m) => (
                <li key={m.id} data-dir={m.direction}>
                  <div className="ib-thread-meta">
                    <span>{t(m.direction === "in" ? "Guest" : m.direction === "staff" ? "Staff" : "Bot")}</span>
                    <time>{relativeAge(m.createdAt, t)}</time>
                  </div>
                  <div>{m.text}</div>
                </li>
              ))}
            </ul>
          )}
          <div className="ib-actions">
            {c.paused ? (
              <button
                type="button"
                className="act-button blue"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await api("POST", `/conversations/${c.id}/hand-back`);
                    return t("Handed back to automation.");
                  })
                }
              >
                {t("Hand back to bot")}
              </button>
            ) : (
              <button
                type="button"
                className="act-button blue"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await api("POST", `/conversations/${c.id}/take-over`);
                    return t("Paused bot for staff reply.");
                  })
                }
              >
                {t("Take over")}
              </button>
            )}
            <a className="act-button" href="#/conversations">{t("Open full thread")}</a>
          </div>
        </div>
      );
    }

    if (item.kind === "receipt") {
      const r = item.data;
      return (
        <div className="ib-detail">
          <div className="ib-item-top">
            <span className="ib-kind" data-kind="receipt">{t("Receipt")}</span>
            <span className="ib-age">{relativeAge(r.createdAt, t)}</span>
          </div>
          <h2>{r.reference}</h2>
          <dl className="ib-facts">
            <div><dt>{t("Amount due")}</dt><dd>{peso(r.amountDue)}</dd></div>
            <div><dt>{t("Submitted")}</dt><dd>{r.submitted === null ? t("Not given") : peso(r.submitted)}</dd></div>
            <div><dt>{t("Reference")}</dt><dd>{r.transferRef ?? t("None")}</dd></div>
            <div><dt>{t("Channel")}</dt><dd>{r.channel}</dd></div>
          </dl>
          {r.flags.length > 0 && (
            <div className="ib-actions">
              {r.flags.map((f) => <span key={f} className="act-pill problem">{t(FLAG_LABELS[f] ?? f)}</span>)}
            </div>
          )}
          {r.type === "reply" ? (
            <>
              {r.replyError && <p className="act-muted">{r.replyError}</p>}
              <div className="ib-actions">
                <button
                  type="button"
                  className="act-button blue"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await api("POST", `/payments/dues/${r.dueId}/retry-reply`);
                      return t("The reply for {ref} is queued again. The payment stays confirmed.", { ref: r.reference });
                    })
                  }
                >
                  {t("Retry reply")}
                </button>
              </div>
            </>
          ) : (
            <>
              {r.hasImage && (
                <a href={`/payments/claims/${r.claimId}/image`} target="_blank" rel="noreferrer">
                  <img className="ib-receipt-img" src={`/payments/claims/${r.claimId}/image`} alt={t("Receipt for {ref}", { ref: r.reference })} />
                </a>
              )}
              <label className="ib-field">
                <span>{t("Reason or question for the customer")}</span>
                <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="ib-actions">
                <button
                  type="button"
                  className="act-button blue"
                  disabled={busy || r.dueStatus !== "pending"}
                  onClick={() => {
                    if (!window.confirm(t("Confirm only if you see {amount} with reference {ref} in your own GCash or bank history. A screenshot is not proof.", { amount: peso(r.submitted ?? r.amountDue), ref: r.transferRef ?? "" }))) return;
                    void perform(async () => {
                      await api("POST", `/payments/claims/${r.claimId}/decide`, { version: r.version, decision: "confirm" });
                      return t("{ref} is confirmed.", { ref: r.reference });
                    });
                  }}
                >
                  {t("Confirm payment")}
                </button>
                <button
                  type="button"
                  className="act-button"
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    void perform(async () => {
                      await api("POST", `/payments/claims/${r.claimId}/decide`, { version: r.version, decision: "clarify", reason: reason.trim() });
                      return t("Question sent to the customer.");
                    })
                  }
                >
                  {t("Ask the customer")}
                </button>
                <button
                  type="button"
                  className="act-button"
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    void perform(async () => {
                      await api("POST", `/payments/claims/${r.claimId}/decide`, { version: r.version, decision: "reject", reason: reason.trim() });
                      return t("Rejected. The customer was told why.");
                    })
                  }
                >
                  {t("Reject")}
                </button>
              </div>
            </>
          )}
        </div>
      );
    }

    if (item.kind === "approval") {
      const a = item.data;
      return (
        <div className="ib-detail">
          <div className="ib-item-top">
            <span className="ib-kind" data-kind="approval">{t("Approval")}</span>
            <span className="ib-age">{relativeAge(a.createdAt, t)}</span>
          </div>
          <h2>{item.title}</h2>
          <div className="ib-msg-box">{a.message || t("Approval requested")}</div>
          {!a.canDecide && a.approverEmail && (
            <p className="act-muted">{t("Assigned to {email}. Only the named approver can decide.", { email: a.approverEmail })}</p>
          )}
          <div className="ib-actions">
            {a.canDecide && (
              <>
                <button
                  type="button"
                  className="act-button blue"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await api("POST", `/inbox/approvals/${a.id}/decide`, { decision: "approved" });
                      return t("Approved and resumed automation.");
                    })
                  }
                >
                  {t("Approve")}
                </button>
                <button
                  type="button"
                  className="act-button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await api("POST", `/inbox/approvals/${a.id}/decide`, { decision: "rejected" });
                      return t("Rejected and resumed automation.");
                    })
                  }
                >
                  {t("Reject")}
                </button>
              </>
            )}
            <a className="act-button" href={`#/runs/${a.runId}`}>{t("Open run")}</a>
          </div>
        </div>
      );
    }

    const r = item.data;
    return (
      <div className="ib-detail">
        <div className="ib-item-top">
          <span className="ib-kind" data-kind="run">{t("Needs check")}</span>
          <span className="ib-age">{relativeAge(r.createdAt, t)}</span>
        </div>
        <h2>{item.title}</h2>
        <div className="ib-msg-box">{r.error || t("A delivery or step stopped and needs you to check it.")}</div>
        <div className="ib-actions">
          <a className="act-button blue" href={`#/runs/${r.id}`}>{t("Open run")}</a>
        </div>
      </div>
    );
  };

  const counts = data?.counts;
  const filters: { key: FilterKind; label: string; count?: number }[] = [
    { key: "all", label: "All", count: counts?.total },
    { key: "conversation", label: "Conversations", count: counts?.conversations },
    { key: "receipt", label: "Receipts", count: counts?.receipts },
    { key: "approval", label: "Approvals", count: counts?.approvals },
    { key: "run", label: "Needs check", count: counts?.runs },
  ];

  return (
    <main className="page act">
      <PageHead
        crumbs={[]}
        title={t("Inbox")}
        sub={counts ? t("{count} waiting on a person", { count: counts.total }) : t("Conversations, receipts, approvals and checks")}
        actions={
          <div className="ib-head-actions">
            <a className="act-button" href="#/conversations">{t("Conversation settings")}</a>
            {user.role === "owner" && <a className="act-button" href="#/receipts">{t("Payment settings")}</a>}
          </div>
        }
      />
      <div className="ib-body motion-page">
        <div className="ib-filters" role="group" aria-label={t("Filter inbox")}>
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              className="ib-chip"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              <span>{t(f.label)}</span>
              {f.count !== undefined && <span className="ib-chip-count">{f.count}</span>}
            </button>
          ))}
        </div>

        <p role="status" className="act-alert ok" hidden={!notice}>{notice}</p>
        <p role="alert" className="act-alert error" hidden={!error}>{error}</p>

        {data === null ? (
          <p className="act-muted" role="status">{t("Loading…")}</p>
        ) : visible.length === 0 ? (
          <section className="act-card ib-empty">
            <h2>{filter === "all" ? t("Nothing waiting on you right now.") : t("None in this filter.")}</h2>
            <p className="act-muted">
              {t("Everything that needs a person gathers here:")}
            </p>
            <ul>
              <li>{t("Guest messages handed off to staff")}</li>
              <li>{t("Transfer receipts waiting for confirmation")}</li>
              <li>{t("Approvals and steps paused for your check")}</li>
            </ul>
            {user.role === "owner" && (
              <div className="ib-actions">
                <a className="act-button blue" href="#/automations">{t("View automations")}</a>
                <a className="act-button" href="#/new">{t("New automation")}</a>
              </div>
            )}
          </section>
        ) : (
          <div className="ib-split">
            <ul className="ib-list" aria-label={t("Inbox items")}>
              {visible.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="ib-item"
                    aria-pressed={chosen?.id === item.id}
                    onClick={() => {
                      setSelectedId(item.id);
                      setReason("");
                      if (phone) setSheetOpen(true);
                    }}
                  >
                    <div className="ib-item-top">
                      <span className="ib-kind" data-kind={item.kind}>{t(KIND_LABELS[item.kind])}</span>
                      <span className="ib-age">{relativeAge(item.createdAt, t)}</span>
                    </div>
                    <span className="ib-title">{item.title}</span>
                    <span className="ib-sub">{item.subtitle}</span>
                  </button>
                </li>
              ))}
            </ul>
            {!phone && chosen && (
              <aside className="ib-drawer" aria-label={chosen.title}>
                {renderDetail(chosen)}
              </aside>
            )}
          </div>
        )}
      </div>
      {phone && sheetOpen && chosen && (
        <Sheet title={chosen.title} onClose={() => setSheetOpen(false)}>
          {renderDetail(chosen)}
        </Sheet>
      )}
    </main>
  );
}
