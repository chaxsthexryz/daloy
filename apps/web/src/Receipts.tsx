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
type Settings = { gcashNumber: string | null; accountName: string | null; hasQr: boolean; receiptRetentionDays: number };

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
      <PageHead crumbs={[]} title={t("Receipts to review")} sub={rows ? t("{n} waiting", { n: rows.length }) : undefined} />
      <div className="act-body rc-body motion-page">
        <p role="status" className="act-alert ok" hidden={!note}>{note}</p>
        <p role="alert" className="act-alert error" hidden={!error}>{error}</p>
        <p className="act-muted">{t("Check each transfer in your own GCash or bank history before you confirm. Payment and reply are tracked apart: a failed reply never undoes a payment.")}</p>
        {rows === null ? (
          <p className="act-muted" role="status">{t("Loading…")}</p>
        ) : rows.length === 0 ? (
          <section className="act-card rc-empty" aria-label={t("How receipt review works")}>
            <h2>{t("Nothing to review.")}</h2>
            <p className="act-muted">{t("New receipts and payment problems appear here. Here is how they flow in:")}</p>
            <ol className="rc-steps">
              <li>{t("A customer pays by QR Ph or GCash and sends their receipt through your pay page, Messenger, Instagram or WhatsApp.")}</li>
              <li>{t("The receipt appears here with the amount due, reference number and any warning flags.")}</li>
              <li>{t("Check your own GCash or bank history, then choose Confirm payment, Ask the customer or Reject.")}</li>
            </ol>
          </section>
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
        <DailyTools owner={user.role === "owner"} />
        {user.role === "owner" && <CustomerData />}
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
  const [days, setDays] = useState("90");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    void api<Settings>("GET", "/payments/settings").then((v) => {
      setS(v);
      setNumber(v.gcashNumber ?? "");
      setName(v.accountName ?? "");
      setDays(String(v.receiptRetentionDays));
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
      setS(await api<Settings>("PUT", "/payments/settings", { gcashNumber: number, accountName: name, receiptRetentionDays: Number(days), ...(qr ? { qr } : {}) }));
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
        <label className="rc-reason"><span>{s.hasQr ? t("Replace QR Ph image") : t("QR Ph image")}</span><input className="file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => pick(e.target.files?.[0])} disabled={!owner} /></label>
        <label className="rc-reason"><span>{t("Keep receipt images for (days)")}</span><input type="number" min={1} max={3650} step={1} value={days} onChange={(e) => setDays(e.target.value)} disabled={!owner} /></label>
        <p className="act-muted">{t("Images are deleted this many days after an order is paid, cancelled or refunded. Amounts and decisions stay in the payment history.")}</p>
        {owner && <div className="act-actions"><button className="act-button blue">{t("Save payment details")}</button></div>}
        <p role="status" className="act-muted">{msg}</p>
      </form>
    </section>
  );
}

type Erased = { counts: Record<string, number>; kept: { item: string; reason: string }[] };

/** R6, decision 0094: the owner answers a customer's request to see or delete their data. Owner only; the server checks the role too. */
function CustomerData() {
  const { t } = useLanguage();
  const [who, setWho] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [done, setDone] = useState<Erased | null>(null);
  const [msg, setMsg] = useState("");
  const q = (v: string): Record<string, string> => (v.includes("@") ? { email: v.trim() } : { phone: v.trim() });
  const exportData = async () => {
    setMsg("");
    const res = await fetch(`/privacy/customer?${new URLSearchParams(q(who))}`);
    if (!res.ok) return setMsg(((await res.json().catch(() => null)) as { message?: string | string[] } | null)?.message?.toString() ?? res.statusText);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = "customer-data.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const erase = async () => {
    setMsg("");
    try {
      setDone(await api<Erased>("POST", "/privacy/customer/delete", { ...q(who), confirm }));
      setConfirm(null);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <section className="act-card rc-details" aria-labelledby="cust-h">
      <h2 id="cust-h">{t("Customer data")}</h2>
      <p className="act-muted">{t("When a customer asks to see or delete what you hold about them, enter the email or phone number they used. Export downloads a file. Delete erases their messages, answers, uploads and receipt images, and keeps amounts and references for your bookkeeping. Data already sent to other apps or email stays there.")}</p>
      <form onSubmit={(e) => e.preventDefault()}>
        <label className="rc-reason"><span>{t("Customer email or phone number")}</span><input value={who} onChange={(e) => { setWho(e.target.value); setDone(null); }} maxLength={200} /></label>
        <div className="act-actions">
          <button className="act-button blue" disabled={!who.trim()} onClick={() => void exportData()}>{t("Export customer data")}</button>
          <button className="act-button" disabled={!who.trim()} onClick={() => setConfirm("")}>{t("Delete customer data")}</button>
        </div>
        {confirm !== null && (
          <>
            <label className="rc-reason"><span>{t("Type DELETE to confirm. This cannot be undone.")}</span><input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></label>
            <div className="act-actions"><button className="act-button" disabled={confirm !== "DELETE"} onClick={() => void erase()}>{t("Delete now")}</button></div>
          </>
        )}
        <p role="status" className="act-muted">{msg}</p>
      </form>
      {done && (
        <div role="status">
          <p>{t("Deleted. Rows changed or removed:")} {Object.entries(done.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || t("none")}</p>
          <ul>{done.kept.map((k) => <li key={k.item}>{k.item}: {k.reason}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

const manilaToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/**
 * R5, decision 0092: a CSV of confirmed payments by Manila day for bookkeeping, and the owner's switch for the morning
 * digest. The download is a plain link: the browser sends the session cookie and the server checks the role.
 */
function DailyTools({ owner }: { owner: boolean }) {
  const { t } = useLanguage();
  const today = manilaToday();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [digest, setDigest] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (owner) api<{ enabled: boolean }>("GET", "/settings/digest").then((d) => setDigest(d.enabled), () => undefined);
  }, [owner]);
  const flip = async (enabled: boolean) => {
    setError("");
    try {
      setDigest((await api<{ enabled: boolean }>("PUT", "/settings/digest", { enabled })).enabled);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const valid = from !== "" && to !== "" && from <= to;
  return (
    <section className="act-card rc-details" aria-labelledby="daily-h">
      <h2 id="daily-h">{t("Export and morning summary")}</h2>
      <form onSubmit={(e) => e.preventDefault()}>
        <p className="act-muted">{t("Download confirmed payments as a CSV for your bookkeeping. Days are Manila days, and the range can be up to one year.")}</p>
        <label className="rc-reason"><span>{t("From")}</span><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="rc-reason"><span>{t("To")}</span><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="act-actions">
          {valid ? <a className="act-button blue" href={`/payments/export.csv?from=${from}&to=${to}`} download>{t("Download payments CSV")}</a> : <span className="act-muted">{t("Choose a start day that is not after the end day.")}</span>}
        </div>
      </form>
      {owner && digest !== null && (
        <div>
          <label className="rc-reason">
            <span><input type="checkbox" checked={digest} onChange={(e) => void flip(e.target.checked)} /> {t("Email me a summary each morning")}</span>
          </label>
          <p className="act-muted">{t("Sent between 8 am and noon Manila time to your sign-in email, only on mornings with receipts to review, unpaid orders or failed replies. It has counts and links, never customer details.")}</p>
          <p role="alert" className="act-alert error" hidden={!error}>{error}</p>
        </div>
      )}
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
