import "./activity.css";
import "./inbox.css";
import { useEffect, useState, type CSSProperties } from "react";
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
  approverName: string | null;
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

const KIND_PILL: Record<InboxItem["kind"], string> = {
  conversation: "blue",
  receipt: "warn",
  approval: "blue",
  run: "bad",
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

function TakeoverIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 15H6C4.93913 15 3.92172 15.4214 3.17157 16.1716C2.42143 16.9217 2 17.9391 2 19V21M14.3049 16.5299L15.2279 16.1479M15.2279 13.8522L14.3049 13.4692M16.852 12.2282L16.469 11.3052M16.852 17.772L16.469 18.696M19.1479 12.2282L19.5309 11.3052M19.5299 18.696L19.1479 17.772M20.772 13.8522L21.696 13.4692M20.772 16.1479L21.696 16.5309M21 15C21 16.6569 19.6569 18 18 18C16.3431 18 15 16.6569 15 15C15 13.3431 16.3431 12 18 12C19.6569 12 21 13.3431 21 15ZM13 7C13 9.20914 11.2091 11 9 11C6.79086 11 5 9.20914 5 7C5 4.79086 6.79086 3 9 3C11.2091 3 13 4.79086 13 7Z" />
    </svg>
  );
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
        <div className="ib-detail motion-page">
          <div className="ib-item-top">
            <span className={`pill ${KIND_PILL.conversation}`}>{t("Conversation")}</span>
            <span className={`pill ${c.paused ? "warn" : "ok"}`}>
              {c.paused ? t("Staff handling") : t("Bot active.")}
            </span>
            <span className="ib-age">{channelLabel(c.channel)}</span>
          </div>
          <h2>{item.title}</h2>
          {(c.fields.phone || c.fields.email) && (
            <p className="act-muted">
              {[c.fields.phone, c.fields.email].filter(Boolean).join(" · ")}
            </p>
          )}
          <div className="takeover-bar" data-mode={c.paused ? "staff" : "bot"}>
            <div className="takeover-info">
              <span className="takeover-ico"><TakeoverIcon /></span>
              <div className="takeover-copy">
                <strong>{c.paused ? t("Paused for staff reply.") : t("Bot active.")}</strong>
                <span>
                  {c.paused
                    ? t("Hand control back to the automation when you are done.")
                    : t("Pause automated replies when a guest needs a person.")}
                </span>
              </div>
            </div>
            {c.paused ? (
              <button
                type="button"
                className="act-button"
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
          </div>
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
                    <time className="tnum">{relativeAge(m.createdAt, t)}</time>
                  </div>
                  <div>{m.text}</div>
                </li>
              ))}
            </ul>
          )}
          <div className="ib-actions">
            <a className="act-button" href="#/conversations">{t("Open full thread")}</a>
          </div>
        </div>
      );
    }

    if (item.kind === "receipt") {
      const r = item.data;
      return (
        <div className="ib-detail motion-page">
          <div className="ib-item-top">
            <span className={`pill ${KIND_PILL.receipt}`}>{t("Receipt")}</span>
            <span className="ib-age tnum">{relativeAge(r.createdAt, t)}</span>
          </div>
          <h2>{r.reference}</h2>
          <dl className="ib-facts">
            <div><dt>{t("Amount due")}</dt><dd className="tnum">{peso(r.amountDue)}</dd></div>
            <div><dt>{t("Submitted")}</dt><dd className="tnum">{r.submitted === null ? t("Not given") : peso(r.submitted)}</dd></div>
            <div><dt>{t("Reference")}</dt><dd className="mono">{r.transferRef ?? t("None")}</dd></div>
            <div><dt>{t("Channel")}</dt><dd>{r.channel}</dd></div>
          </dl>
          {r.flags.length > 0 && (
            <div className="ib-actions">
              {r.flags.map((f) => <span key={f} className="pill bad">{t(FLAG_LABELS[f] ?? f)}</span>)}
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
        <div className="ib-detail motion-page">
          <div className="ib-item-top">
            <span className={`pill ${KIND_PILL.approval}`}>{t("Approval")}</span>
            <span className="ib-age tnum">{relativeAge(a.createdAt, t)}</span>
          </div>
          <h2>{item.title}</h2>
          <div className="ib-msg-box">{a.message || t("Approval requested")}</div>
          {!a.canDecide && a.approverEmail && (
            <p className="act-muted">{t("Assigned to {email}. Only the named approver can decide.", { email: a.approverName ?? a.approverEmail })}</p>
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
      <div className="ib-detail motion-page">
        <div className="ib-item-top">
          <span className={`pill ${KIND_PILL.run}`}>{t("Needs check")}</span>
          <span className="ib-age tnum">{relativeAge(r.createdAt, t)}</span>
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
        <div className="ib-filters p-seg" role="group" aria-label={t("Filter inbox")}>
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              className="ib-chip p-btn"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              <span>{t(f.label)}</span>
              {f.count !== undefined && <span className="ib-chip-count tnum">{f.count}</span>}
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
            <ul className="ib-list ib-queue-list" aria-label={t("Inbox items")}>
              {visible.map((item, idx) => {
                const active = chosen?.id === item.id;
                return (
                  <li key={item.id} className="motion-stagger-row" style={{ "--i": Math.min(idx, 12) } as CSSProperties}>
                    <button
                      type="button"
                      className="ib-item queue-btn"
                      aria-pressed={active}
                      onClick={() => {
                        setSelectedId(item.id);
                        setReason("");
                        if (phone) setSheetOpen(true);
                      }}
                    >
                      <div className="ib-item-top">
                        {active && <i className="active-dot" aria-hidden="true" />}
                        <span className={`pill ${KIND_PILL[item.kind]} ib-kind`} data-kind={item.kind}>{t(KIND_LABELS[item.kind])}</span>
                        <span className="ib-age tnum">{relativeAge(item.createdAt, t)}</span>
                      </div>
                      <span className="ib-title">{item.title}</span>
                      <span className="ib-sub">{item.subtitle}</span>
                    </button>
                  </li>
                );
              })}
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
