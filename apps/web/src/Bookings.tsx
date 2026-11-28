import { Text, useLanguage } from "./Language";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { PageHead } from "./Runs";
import { BookingPayments } from "./Receipts";
import { ResourcesPage } from "./Resources";
import "./activity.css";
import { longDate } from "./lib/activity";
import { ampm, byDay } from "./lib/agenda";

type BookingGuest = {
  channel: "messenger" | "instagram" | "email" | "telegram" | "whatsapp";
  externalId: string;
  name?: string;
  email?: string;
  phone?: string;
};

type Booking = {
  id: string;
  reference: string;
  resource: { id: string; name: string; label?: string };
  start: string;
  end: string;
  timezone: string;
  status: "active" | "cancelled" | "no_show";
  version: number;
  attention: boolean;
  runId: string | null;
  nights?: number;
  checkIn?: string;
  checkOut?: string;
  conversationId?: string;
  guest?: BookingGuest;
};

// "2027-01-20T14:00:00+08:00" -> "2027-01-20 14:00": the booking's own local time, as the customer chose it.
const local = (zoned: string) => zoned.slice(0, 16).replace("T", " ");
const STATUS = { active: "Active", cancelled: "Cancelled", no_show: "No-show" } as const;

/**
 * Bookings (O4, Doop frame PtNZfoOj94, option B): a day agenda beside the selected booking, for owners and operators
 * (decision 0032). Each change sends the version shown here, so a change made by someone else in between is refused
 * instead of overwritten. On a phone the selected booking opens as a sheet over the agenda.
 */
export function BookingsPage({ initialTab = "calendar", canManageRooms = false }: { initialTab?: "calendar" | "rooms"; canManageRooms?: boolean } = {}) {
  const { t, language } = useLanguage();
  const [list, setList] = useState<Booking[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [moving, setMoving] = useState<{ id: string; start: string } | null>(null);
  const [note, setNote] = useState("");
  const tab = canManageRooms ? initialTab : "calendar";
  // Only the newest list request may set the list (see Resources.tsx).
  const latest = useRef(0);
  const load = () => {
    const n = ++latest.current;
    return api<Booking[]>("GET", "/bookings").then(
      (rows) => n === latest.current && setList(rows),
      (e: Error) => setError(e.message),
    );
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!sheet) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setSheet(false);
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [sheet]);
  const run = async (action: () => Promise<string>) => {
    setError("");
    setNote("");
    try {
      setNote(await action());
    } catch (err) {
      setError((err as Error).message);
    }
    await load();
  };
  const cancel = (b: Booking) => {
    if (!confirm(t("Cancel {reference} with {resource} on {time}? Its reminders stop.", { reference: b.reference, resource: b.resource.name, time: local(b.start) }))) return;
    return run(async () => {
      await api("POST", `/bookings/${b.id}/cancel`, { version: b.version });
      return t("{reference} is cancelled.", { reference: b.reference });
    });
  };
  const noShow = (b: Booking) => {
    if (!confirm(t("Mark {reference} as a no-show? The follow-up email to the guest starts. You can undo this until it has gone out.", { reference: b.reference }))) return;
    return run(async () => {
      await api("POST", `/bookings/${b.id}/no-show`, { version: b.version });
      return t("{reference} is marked as a no-show. The follow-up has started.", { reference: b.reference });
    });
  };
  const undoNoShow = (b: Booking) =>
    run(async () => {
      await api("POST", `/bookings/${b.id}/undo-no-show`, { version: b.version });
      return t("{reference} is active again. The follow-up was stopped.", { reference: b.reference });
    });
  const reschedule = (b: Booking, value: string) =>
    run(async () => {
      const body = b.nights !== undefined ? { version: b.version, checkIn: value } : { version: b.version, start: value };
      const r = await api<{ booking: Booking }>("POST", `/bookings/${b.id}/reschedule`, body);
      setMoving(null);
      return b.nights !== undefined
        ? t("{reference} moved to {time} ({nights} nights kept).", { reference: b.reference, time: local(r.booking.start), nights: b.nights })
        : t("{reference} moved to {time}. A new run sends its messages; the old reminders stop.", { reference: b.reference, time: local(r.booking.start) });
    });

  const days = byDay(list ?? []);
  const chosen = list?.find((b) => b.id === picked) ?? days[0]?.items[0] ?? null;

  return (
    <main className="page act">
      {/* The sidebar tree links Calendar and Rooms and slots (decision 0164); the head links the other one. */}
      <PageHead
        crumbs={[]}
        title={t(tab === "rooms" ? "Rooms and slots" : "Calendar")}
        sub={tab === "rooms" ? t("Rooms, people or tables that customers can book. Booking forms and stay confirmations list the active items below.") : longDate(Date.now(), language)}
        actions={
          <div className="act-actions">
            {tab === "calendar" && <a className="act-button" href="/bookings/export.csv" download>{t("Download CSV")}</a>}
            {canManageRooms && (tab === "calendar"
              ? <a className="act-button" href="#/bookings?tab=rooms">{t("Rooms and slots")}</a>
              : <a className="act-button" href="#/bookings">{t("Calendar")}</a>)}
          </div>
        }
      />
      {tab === "rooms" ? (
        <ResourcesPage embedded />
      ) : (
      <div className="act-body act-bookings motion-page">
        <p role="status" className="act-alert ok" hidden={!note}>{note}</p>
        <p role="alert" className="act-alert error" hidden={!error}>{error}</p>
        {sheet && <div className="act-backdrop motion-backdrop" aria-hidden="true" onClick={() => setSheet(false)} />}
        {chosen && (
          <section className="act-card act-booking" data-sheet={sheet || undefined} aria-labelledby="booking-h" key={chosen.id}>
            <div className="act-booking-top">
              <p className="act-eyebrow">{t("Selected booking")}</p>
              <span className="act-mono">{chosen.reference}</span>
              <button type="button" className="act-button act-sheet-close" onClick={() => setSheet(false)}>{t("Close")}</button>
            </div>
            <h2 id="booking-h">
              {chosen.resource.name}
              {chosen.resource.label && <span className="act-pill">{chosen.resource.label}</span>}
            </h2>
            <p className="act-muted">
              {chosen.nights !== undefined
                ? `${local(chosen.start)}${t(" to ")}${local(chosen.end)} (${t("{nights} nights", { nights: chosen.nights })}, ${chosen.timezone})`
                : `${local(chosen.start)}${t(" to ")}${local(chosen.end).slice(11)} (${chosen.timezone})`}
            </p>
            {chosen.guest && (
              <p className="act-muted">
                {t("Guest")}: {[chosen.guest.name, chosen.guest.email, chosen.guest.phone].filter(Boolean).join(" · ") || `${chosen.guest.channel} (${chosen.guest.externalId})`}
              </p>
            )}
            <p className="act-status-box">
              {t(STATUS[chosen.status])}
              {chosen.attention && <span className="act-pill problem">{t("needs attention")}</span>}
            </p>
            {chosen.attention && <p className="act-muted">{t("The run for this booking failed or waits for review. The booking is still active.")}</p>}
            {chosen.runId && <p><a href={`#/runs/${chosen.runId}`}>{t("Open run detail")}</a></p>}
            <BookingPayments bookingId={chosen.id} />
            {moving?.id === chosen.id ? (
              <form
                className="act-move"
                onSubmit={(e) => {
                  e.preventDefault();
                  void reschedule(chosen, moving.start);
                }}
              >
                <label htmlFor={`move-${chosen.id}`}>
                  {chosen.nights !== undefined
                    ? t("New check-in date ({nights} nights kept, {timezone})", { nights: chosen.nights, timezone: chosen.timezone })
                    : t("New time ({timezone})", { timezone: chosen.timezone })}
                </label>
                <input
                  id={`move-${chosen.id}`}
                  type={chosen.nights !== undefined ? "date" : "datetime-local"}
                  value={moving.start}
                  onChange={(e) => setMoving({ id: chosen.id, start: e.target.value })}
                  required
                />
                <div className="act-actions">
                  <button className="act-button blue"><Text>Move</Text></button>
                  <button type="button" className="act-button" onClick={() => setMoving(null)}>{t("Keep")}</button>
                </div>
              </form>
            ) : (
              <div className="act-actions">
                {chosen.status === "active" && (
                  <>
                    <button
                      type="button"
                      className="act-button"
                      onClick={() => setMoving({ id: chosen.id, start: chosen.nights !== undefined ? (chosen.checkIn ?? chosen.start.slice(0, 10)) : chosen.start.slice(0, 16) })}
                    >
                      {t("Reschedule")}
                    </button>
                    <button type="button" className="act-button" onClick={() => cancel(chosen)}>{t("Cancel booking")}</button>
                    {Date.parse(chosen.start) <= Date.now() && <button type="button" className="act-button" onClick={() => noShow(chosen)}>{t("Mark no-show")}</button>}
                  </>
                )}
                {chosen.status === "no_show" && <button type="button" className="act-button" onClick={() => undoNoShow(chosen)}>{t("Undo no-show")}</button>}
              </div>
            )}
          </section>
        )}
        <section className="act-card act-agenda" aria-labelledby="agenda-h">
          <h2 id="agenda-h">{t("Day agenda")}</h2>
          {list === null ? (
            <p className="act-muted" role="status">{t("Loading…")}</p>
          ) : list.length === 0 ? (
            <p className="act-muted">
              <Text>No bookings yet. They appear when an automation's booking step books a resource.</Text>{" "}
              {canManageRooms && <a href="#/bookings?tab=rooms">{t("Manage rooms and slots")}</a>}
            </p>
          ) : (
            days.map(({ day, items }) => (
              <div key={day} className="act-day">
                <h3 className="act-eyebrow">{longDate(`${day}T12:00:00`, language)}</h3>
                <ul>
                  {items.map((b) => (
                    <li key={b.id}>
                      <button type="button" aria-pressed={b.id === chosen?.id} onClick={() => { setPicked(b.id); setSheet(true); setMoving(null); }}>
                        <span className="act-queue-top">
                          {b.id === chosen?.id && <i className="act-active-dot" aria-hidden="true" />}
                          <span className="act-mono">{ampm(b.start.slice(11, 16))}</span>
                          <span className={`act-agenda-state act-pill ${b.status === "active" ? (b.attention ? "problem" : "ok") : b.status}`}>{t(STATUS[b.status])}{b.attention && ` · ${t("needs attention")}`}</span>
                        </span>
                        <span className="act-agenda-what">
                          <span className="title">{b.reference}</span>
                          <span className="act-muted">
                            {b.resource.name}
                            {b.nights !== undefined
                              ? ` · ${t("{nights} nights", { nights: b.nights })} · ${b.checkIn ?? b.start.slice(0, 10)}${t(" to ")}${b.checkOut ?? b.end.slice(0, 10)}`
                              : ` · ${local(b.start).slice(11)}${t(" to ")}${local(b.end).slice(11)}`}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      </div>
      )}
    </main>
  );
}
