import { useState } from "react";
import { api } from "./api";
import { ConnectPanel, useAction } from "./ConnectPanel";
import { CalendarConnection, Outcome, type Connection, type TestResult } from "./Connections";
import { useLanguage } from "./Language";

/**
 * The Google Calendar card for "Connect with Google" (decision 0064): the main action is a Google sign-in with
 * calendar.app.created, after which Daloy makes its own "Daloy bookings" calendar, so nothing is picked or typed. The
 * service account form and calendar id stay under Advanced, and are the whole card on an installation without a Google client.
 */
export function GoogleCalendarCard({ conn, configured, outcome, onChange }: { conn: Connection | null; configured: boolean; outcome?: string; onChange: () => Promise<unknown> }) {
  const { t } = useLanguage();
  const { error, busy, act } = useAction(onChange);
  const [test, setTest] = useState<TestResult | null>(null);
  if (!configured) return <CalendarConnection conn={conn} onChange={onChange} />;
  const oauth = conn?.authMethod === "oauth";
  const create = (again: boolean) => act(() => api("POST", "/settings/connections/google-calendar/create", { again }));

  return (
    <ConnectPanel
      slug="google-calendar"
      name="Google Calendar"
      connectLabel="Connect with Google"
      configured
      conn={conn}
      label={oauth ? "Account" : "Service account"}
      outcome={outcome}
      onChange={onChange}
      intro={!conn && <p>{t("Google will ask you to let Daloy see your email address and use only the calendar Daloy creates for your bookings. Daloy cannot see your other calendars.")}</p>}
      actions={
        conn?.destination && (
          <button type="button" disabled={busy} onClick={() => void act(async () => setTest(await api<TestResult>("POST", "/settings/connections/google-calendar/test")))}>
            {t("Add a test event")}
          </button>
        )
      }
      after={
        <>
          <Outcome test={test} what={t("Google Calendar accepted a test event")} />
          <p role="alert" className="message error" hidden={!error}>
            {error}
          </p>
        </>
      }
      form={<CalendarConnection conn={oauth ? null : conn} onChange={onChange} embedded />}
    >
      {conn?.destination && (
        <p>
          {t("Events go to ")}
          <strong>{conn.destination.title}</strong>
          {t(". An event follows its booking: moved when the booking is rescheduled, deleted when it is cancelled.")}
        </p>
      )}
      {oauth && (
        <div className="actions">
          {!conn.destination && (
            <button type="button" className="primary" disabled={busy} onClick={() => void create(false)}>
              {t("Create the Daloy bookings calendar")}
            </button>
          )}
          {conn.destination && (
            <button type="button" className="quiet" disabled={busy} onClick={() => window.confirm(t("Create a new Daloy bookings calendar? Events already in the old one stay there, and changes to those bookings wait for your review.")) && void create(true)}>
              {t("Create a new Daloy calendar")}
            </button>
          )}
        </div>
      )}
    </ConnectPanel>
  );
}
