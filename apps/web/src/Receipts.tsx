import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useLanguage } from "./Language";
import { PageHead } from "./Runs";
import type { User } from "./Team";
import "./activity.css";
import "./receipts.css";

type Flag = "duplicate_reference" | "amount_mismatch" | "unreadable_upload" | "already_confirmed" | "paid_twice" | "late_payment";
type Row = {
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
  flags: Flag[];
  status: string;
  dueStatus: string;
  confirmedSource: "transfer" | "checkout" | null;
  reviewer: string | null;
  hasImage: boolean;
  replyState: string | null;
  replyError: string | null;
  createdAt: string;
};
type Settings = { gcashNumber: string | null; accountName: string | null; hasQr: boolean };

const FLAGS: Record<Flag, string> = {
  duplicate_reference: "Reference used before",
  amount_mismatch: "Amount differs",
  unreadable_upload: "Upload not readable",
  already_confirmed: "Already confirmed",
  paid_twice: "Paid twice",
  late_payment: "Paid after the deadline",
};
const CHANNELS: Record<string, string> = { transfer: "QR Ph or GCash transfer", checkout: "PayMongo checkout", sms: "SMS", messenger: "Messenger" };
const KINDS = { deposit: "Deposit", full: "Payment", balance: "Balance" } as const;

/** Centavos as "PHP 1,234.50", integer math only. */
export const peso = (c: number) => `PHP ${Math.floor(c / 100).toLocaleString("en-PH")}.${String(c % 100).padStart(2, "0")}`;

function age(iso: string, t: (s: string, v?: Record<string, string | number>) => string) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return t("{n} min", { n: mins });
  if (mins < 48 * 60) return t("{n} h", { n: Math.round(mins / 60) });
  return t("{n} days", { n: Math.round(mins / 1440) });
}

/**
 * Receipts to review (R3, decision 0090): manual transfer receipts and PayMongo exceptions in one list, oldest first,
 * then confirmed payments whose reply failed. A decision sends the version shown, so two reviewers cannot both decide.
 */
export function ReceiptsPage({ user }: { user: User }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<Record<string, string>>({});
  const latest = useRef(0);
  const load = () => {
    const n = ++latest.current;
    return api<Row[]>("GET", "/payments/review").then(
      (r) => n === latest.current && setRows(r),
      (e: Error) => setError(e.message),
    );
  };
  useEffect(() => {
    void load();
  }, []);

  const act = async (work: () => Promise<string>) => {
    setError("");
    setNote("");
    try {
      setNote(await work());
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };
  const decide = (r: Row, decision: "confirm" | "reject" | "clarify") =>
    act(async () => {
      if (decision === "confirm" && !confirm(t("Confirm only if you see {amount} with reference {ref} in your own GCash or bank history. A screenshot is not proof.", { amount: peso(r.submitted ?? r.amountDue), ref: r.transferRef ?? "" }))) return "";
      const res = await api<{ checkoutOpen: boolean }>("POST", `/payments/claims/${r.claimId}/decide`, { version: r.version, decision, reason: reason[r.claimId!] || undefined });
      if (decision === "reject") return t("Rejected. The customer was told why.");
      if (decision === "clarify") return t("Question sent to the customer.");
      return res.checkoutOpen ? t("{ref} is confirmed. Its PayMongo checkout is still open: if the customer pays it too, it shows here as paid twice.", { ref: r.reference }) : t("{ref} is confirmed.", { ref: r.reference });
    });
  const retry = (r: Row) =>
    act(async () => {
      await api("POST", `/payments/dues/${r.dueId}/retry-reply`);
      return t("The reply for {ref} is queued again. The payment stays confirmed.", { ref: r.reference });
    });

  return (
    <main className="page act">
      <PageHead crumbs={[{ label: "Daloy", href: "#/" }, { label: t("Receipts to review") }]} title={t("Receipts to review")} sub={rows ? t("{n} waiting", { n: rows.length }) : undefined} />
      <div className="act-body rc-body motion-page">
        <p role="status" className="act-alert ok" hidden={!note}>{note}</p>
        <p role="alert" className="act-alert error" hidden={!error}>{error}</p>
        <p className="act-muted">{t("Check each transfer in your own GCash or bank history before you confirm. Payment and reply are tracked apart: a failed reply never undoes a payment.")}</p>
        {rows === null ? (
          <p className="act-muted" role="status">{t("Loading…")}</p>
        ) : rows.length === 0 ? (
          <p className="act-card rc-empty">{t("Nothing to review. New receipts and payment problems appear here.")}</p>
        ) : (
          <ul className="rc-list" aria-label={t("Receipts to review")}>
            {rows.map((r) => (
              <li key={r.claimId ?? `reply-${r.dueId}`} className="act-card rc-row">
                <div className="rc-top">
                  <span className="act-mono rc-ref">{r.reference}</span>
                  {r.bookingReference && r.bookingReference !== r.reference && <span className="act-muted">{t("Booking {ref}", { ref: r.bookingReference })}</span>}
                  <span className="act-muted rc-age">{age(r.createdAt, t)}</span>
                </div>
                <dl className="rc-facts">
                  <div><dt>{t("Amount due")}</dt><dd>{peso(r.amountDue)} <span className="act-muted">({t(KINDS[r.kind])})</span></dd></div>
                  {r.type === "claim" && <div><dt>{t("Submitted")}</dt><dd>{r.submitted === null ? t("Not given") : peso(r.submitted)}</dd></div>}
                  {r.type === "claim" && <div><dt>{t("Reference")}</dt><dd className="act-mono">{r.transferRef ?? t("None")}</dd></div>}
                  <div><dt>{t("Channel")}</dt><dd>{t(CHANNELS[r.channel] ?? r.channel)}</dd></div>
                  {r.reviewer && <div><dt>{t("Reviewer")}</dt><dd>{r.reviewer}</dd></div>}
                </dl>
                <p className="rc-flags">
                  {r.type === "reply" ? (
                    <>
                      <span className="act-pill done">{t("Payment confirmed")}</span> <span className="act-pill problem">{t("Reply failed")}</span>
                    </>
                  ) : (
                    <>
                      {r.status === "clarify" && <span className="act-pill working">{t("Waiting for the customer")}</span>}
                      {r.flags.map((f) => <span key={f} className="act-pill problem">{t(FLAGS[f])}</span>)}
                    </>
                  )}
                </p>
                {r.type === "reply" ? (
                  <>
                    {r.replyError && <p className="act-muted">{r.replyError}</p>}
                    <div className="act-actions">
                      {r.replyState === "failed" ? <button type="button" className="act-button blue" onClick={() => retry(r)}>{t("Retry reply")}</button> : <p className="act-muted">{t("The reply may have gone out. Check it in Activity before sending again.")}</p>}
                    </div>
                  </>
                ) : (
                  <>
                    {r.hasImage && <p><a href={`/payments/claims/${r.claimId}/image`} target="_blank" rel="noreferrer">{t("Open receipt image")}</a></p>}
                    <label className="rc-reason">
                      <span>{t("Reason or question for the customer")}</span>
                      <input value={reason[r.claimId!] ?? ""} maxLength={500} onChange={(e) => setReason({ ...reason, [r.claimId!]: e.target.value })} />
                    </label>
                    <div className="act-actions">
                      <button type="button" className="act-button blue" onClick={() => decide(r, "confirm")} disabled={r.dueStatus !== "pending"}>{t("Confirm payment")}</button>
                      <button type="button" className="act-button" onClick={() => decide(r, "clarify")} disabled={!reason[r.claimId!]?.trim()}>{t("Ask the customer")}</button>
                      <button type="button" className="act-button" onClick={() => decide(r, "reject")} disabled={!reason[r.claimId!]?.trim()}>{t("Reject")}</button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <PaymentDetails owner={user.role === "owner"} />
      </div>
    </main>
  );
}

/** What the pay page shows customers. Only the owner changes it: it says where money goes. */
function PaymentDetails({ owner }: { owner: boolean }) {
  const { t } = useLanguage();
  const [s, setS] = useState<Settings | null>(null);
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [qr, setQr] = useState<string | undefined>();
  const [msg, setMsg] = useState("");
  useEffect(() => {
    void api<Settings>("GET", "/payments/settings").then((v) => {
      setS(v);
      setNumber(v.gcashNumber ?? "");
      setName(v.accountName ?? "");
    });
  }, []);
  const pick = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setQr(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  };
  const save = async () => {
    setMsg("");
    try {
      setS(await api<Settings>("PUT", "/payments/settings", { gcashNumber: number, accountName: name, ...(qr ? { qr } : {}) }));
      setQr(undefined);
      setMsg(t("Saved. Customers see this on their pay page."));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  if (!s) return null;
  return (
    <section className="act-card rc-details" aria-labelledby="pay-details-h">
      <h2 id="pay-details-h">{t("How customers pay you")}</h2>
      <p className="act-muted">{t("Shown on each order's pay page with the amount and order reference.")}</p>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="rc-reason"><span>{t("GCash or account number")}</span><input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={40} disabled={!owner} /></label>
        <label className="rc-reason"><span>{t("Account name")}</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} disabled={!owner} /></label>
        <label className="rc-reason"><span>{s.hasQr ? t("Replace QR Ph image") : t("QR Ph image")}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => pick(e.target.files?.[0])} disabled={!owner} /></label>
        {owner && <div className="act-actions"><button className="act-button blue">{t("Save payment details")}</button></div>}
        <p role="status" className="act-muted">{msg}</p>
      </form>
    </section>
  );
}

type DueView = {
  id: string;
  reference: string;
  kind: "deposit" | "full" | "balance";
  status: "pending" | "confirmed" | "cancelled" | "refunded";
  amount: number;
  total: number | null;
  outstanding: number;
  confirmedSource: "transfer" | "checkout" | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  history: { event: string; source: string; actor: string | null; at: string }[];
};
const DUE_STATUS = { pending: "Waiting for payment", confirmed: "Confirmed", cancelled: "Cancelled, not paid", refunded: "Refunded" } as const;
const EVENTS: Record<string, string> = {
  requested: "Payment requested",
  receipt_submitted: "Receipt submitted, in review",
  confirmed: "Confirmed",
  reply_queued: "Confirmation reply queued",
  reply_retried: "Reply sent again",
  rejected: "Receipt rejected",
  clarification_requested: "Customer asked to clarify",
  checkout_needs_review: "PayMongo payment needs review",
  expired: "Cancelled at the deadline",
  refunded: "Refunded",
};
const SOURCES: Record<string, string> = { transfer: "QR Ph transfer", checkout: "PayMongo checkout", staff: "staff", workflow: "workflow" };

/** The one payment history of a booking: deposit and balance apart, and who or what confirmed each. */
export function BookingPayments({ bookingId }: { bookingId: string }) {
  const { t } = useLanguage();
  const [dues, setDues] = useState<DueView[] | null>(null);
  useEffect(() => {
    setDues(null);
    void api<DueView[]>("GET", `/payments/dues?booking=${bookingId}`).then(setDues, () => setDues([]));
  }, [bookingId]);
  if (!dues || dues.length === 0) return null;
  return (
    <div className="rc-booking" aria-label={t("Payments")}>
      <h3 className="act-eyebrow">{t("Payments")}</h3>
      {dues.map((d) => (
        <div key={d.id} className="rc-due">
          <p>
            <strong>{t(KINDS[d.kind])} {peso(d.amount)}</strong> <span className={`act-pill ${d.status === "confirmed" ? "done" : d.status === "pending" ? "working" : "problem"}`}>{t(DUE_STATUS[d.status])}</span>
          </p>
          {d.confirmedSource && (
            <p className="act-muted">
              {d.confirmedSource === "checkout" ? t("Confirmed by a verified PayMongo payment") : t("Confirmed by {who} after checking the transfer", { who: d.confirmedBy ?? t("a reviewer") })}
              {d.confirmedAt && `, ${new Date(d.confirmedAt).toLocaleString()}`}
            </p>
          )}
          {d.outstanding > 0 && <p className="rc-balance">{t("Balance outstanding: {amount}", { amount: peso(d.outstanding) })}</p>}
          <ol className="rc-history">
            {d.history.map((h, i) => (
              <li key={i}>
                <span className="act-muted">{new Date(h.at).toLocaleString()}</span> {t(EVENTS[h.event] ?? h.event)} <span className="act-muted">({t(SOURCES[h.source] ?? h.source)}{h.actor ? `, ${h.actor}` : ""})</span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
