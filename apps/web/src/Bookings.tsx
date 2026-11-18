import { Text, useLanguage } from "./Language";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type Booking = {
  id: string;
  reference: string;
  resource: { id: string; name: string };
  start: string;
  end: string;
  timezone: string;
  status: "active" | "cancelled" | "no_show";
  version: number;
  attention: boolean;
  runId: string | null;
};

// "2027-01-20T14:00:00+08:00" -> "2027-01-20 14:00": the booking's own local time, as the customer chose it.
const local = (zoned: string) => zoned.slice(0, 16).replace("T", " ");

/**
 * Live bookings for owners and operators (decision 0032): cancel, or move to another time. Each change sends the
 * version shown here, so a change made by someone else in between is refused instead of overwritten.
 */
export function BookingsPage() {
  const { t } = useLanguage();
  const [list, setList] = useState<Booking[] | null>(null);
  const [error, setError] = useState("");
  const [moving, setMoving] = useState<{ id: string; start: string } | null>(null);
  const [note, setNote] = useState("");
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
  const reschedule = (b: Booking, start: string) =>
    run(async () => {
      const r = await api<{ booking: Booking }>("POST", `/bookings/${b.id}/reschedule`, { version: b.version, start });
      setMoving(null);
      return t("{reference} moved to {time}. A new run sends its messages; the old reminders stop.", { reference: b.reference, time: local(r.booking.start) });
    });

  return (
    <main className="page">
      <header className="toolbar plain">
        <h1><Text>Bookings</Text></h1>
        <a href="/bookings/export.csv" download>{t("Download CSV")}</a>
      </header>
      <p role="status" className="message ok" hidden={!note}>
        {note}
      </p>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {list === null ? (
        <p>{t("Loading…")}</p>
      ) : list.length === 0 ? (
        <p><Text>No bookings yet. They appear when a workflow's booking step books a resource.</Text></p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col"><Text>Reference</Text></th>
                <th scope="col"><Text>Resource</Text></th>
                <th scope="col"><Text>Time</Text></th>
                <th scope="col"><Text>Status</Text></th>
                <th scope="col">
                  <span className="sr-only"><Text>Actions</Text></span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <td>{b.runId ? <a href={`#/runs/${b.runId}`}>{b.reference}</a> : b.reference}</td>
                  <td>{b.resource.name}</td>
                  <td>
                    {local(b.start)}{t(" to ")}{local(b.end).slice(11)} <span className="muted">({b.timezone})</span>
                  </td>
                  <td>
                    <span className={`badge ${b.status === "active" ? "succeeded" : "cancelled"}`}>{t(b.status)}</span>
                    {b.attention && (
                      <span className="badge failed" title={t("The run for this booking failed or waits for review. The booking is still active.")}>
                        {" "}{t("needs attention")}</span>
                    )}
                  </td>
                  <td>
                    {b.status === "active" && moving?.id !== b.id && (
                      <>
                        <button type="button" className="quiet" onClick={() => setMoving({ id: b.id, start: b.start.slice(0, 16) })}>{t("Reschedule")}</button>
                        <button type="button" className="quiet" onClick={() => cancel(b)}>{t("Cancel")}</button>
                        {Date.parse(b.start) <= Date.now() && <button type="button" className="quiet" onClick={() => noShow(b)}>{t("Mark no-show")}</button>}
                      </>
                    )}
                    {b.status === "no_show" && <button type="button" className="quiet" onClick={() => undoNoShow(b)}>{t("Undo no-show")}</button>}
                    {moving?.id === b.id && (
                      <form
                        className="row"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void reschedule(b, moving.start);
                        }}
                      >
                        <label htmlFor={`move-${b.id}`}>{t("New time ({timezone})", { timezone: b.timezone })}</label>
                        <input id={`move-${b.id}`} type="datetime-local" value={moving.start} onChange={(e) => setMoving({ id: b.id, start: e.target.value })} required />
                        <button className="primary"><Text>Move</Text></button>
                        <button type="button" className="quiet" onClick={() => setMoving(null)}>{t("Keep")}</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
