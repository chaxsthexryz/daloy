import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type Booking = {
  id: string;
  reference: string;
  resource: { id: string; name: string };
  start: string;
  end: string;
  timezone: string;
  status: "active" | "cancelled";
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
    if (!confirm(`Cancel ${b.reference} with ${b.resource.name} on ${local(b.start)}? Its reminders stop.`)) return;
    return run(async () => {
      await api("POST", `/bookings/${b.id}/cancel`, { version: b.version });
      return `${b.reference} is cancelled.`;
    });
  };
  const reschedule = (b: Booking, start: string) =>
    run(async () => {
      const r = await api<{ booking: Booking }>("POST", `/bookings/${b.id}/reschedule`, { version: b.version, start });
      setMoving(null);
      return `${b.reference} moved to ${local(r.booking.start)}. A new run sends its messages; the old reminders stop.`;
    });

  return (
    <main className="page">
      <header className="toolbar plain">
        <a href="#/">Workflows</a>
        <h1>Bookings</h1>
      </header>
      <p role="status" className="message ok" hidden={!note}>
        {note}
      </p>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {list === null ? (
        <p>Loading…</p>
      ) : list.length === 0 ? (
        <p>No bookings yet. They appear when a workflow's booking step books a resource.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Resource</th>
                <th scope="col">Time</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <td>{b.runId ? <a href={`#/runs/${b.runId}`}>{b.reference}</a> : b.reference}</td>
                  <td>{b.resource.name}</td>
                  <td>
                    {local(b.start)} to {local(b.end).slice(11)} <span className="muted">({b.timezone})</span>
                  </td>
                  <td>
                    <span className={`badge ${b.status === "active" ? "succeeded" : "cancelled"}`}>{b.status}</span>
                    {b.attention && (
                      <span className="badge failed" title="The run for this booking failed or waits for review. The booking is still active.">
                        {" "}
                        needs attention
                      </span>
                    )}
                  </td>
                  <td>
                    {b.status === "active" && moving?.id !== b.id && (
                      <>
                        <button type="button" className="quiet" onClick={() => setMoving({ id: b.id, start: b.start.slice(0, 16) })}>
                          Reschedule
                        </button>
                        <button type="button" className="quiet" onClick={() => cancel(b)}>
                          Cancel
                        </button>
                      </>
                    )}
                    {moving?.id === b.id && (
                      <form
                        className="row"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void reschedule(b, moving.start);
                        }}
                      >
                        <label htmlFor={`move-${b.id}`}>New time ({b.timezone})</label>
                        <input id={`move-${b.id}`} type="datetime-local" value={moving.start} onChange={(e) => setMoving({ id: b.id, start: e.target.value })} required />
                        <button className="primary">Move</button>
                        <button type="button" className="quiet" onClick={() => setMoving(null)}>
                          Keep
                        </button>
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
