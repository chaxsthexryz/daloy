import { useEffect, useId, useState } from "react";
import type { Trigger } from "@daloy/engine";
import { api } from "./api";
import { useLanguage } from "./Language";

/** G2 (decision 0127): the settings and status of a Google Sheets, Calendar or Drive trigger in the editor. */
export type GoogleTrigger = Extract<Trigger, { type: "sheets_row" | "calendar_event" | "drive_file" }>;
type Status = {
  problem: string | null;
  destination: string | null;
  tabs?: string[];
  watching: { problem: string | null; failures: number; started: boolean; lastPolledAt: string | null } | null;
};

export function GoogleTriggerSettings({ trigger, workflowId, onChange }: { trigger: GoogleTrigger; workflowId: string; onChange: (t: Trigger) => void }) {
  const { t } = useLanguage();
  const id = useId();
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ workflowId, ...(trigger.type === "sheets_row" ? { tabs: "1" } : {}) });
    api<Status>("GET", `/triggers/google/${trigger.type}?${q}`)
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [trigger.type, workflowId]);

  const tabs = status?.tabs ?? [];
  const watching = status?.watching;
  return (
    <>
      {trigger.type === "sheets_row" && (
        <div className="field">
          <label htmlFor={`${id}-tab`}>{t("Tab to watch")}</label>
          {tabs.length > 0 ? (
            <select id={`${id}-tab`} value={trigger.config.tab} onChange={(e) => onChange({ type: "sheets_row", config: { tab: e.target.value } })}>
              {!tabs.includes(trigger.config.tab) && <option value={trigger.config.tab}>{trigger.config.tab}</option>}
              {tabs.map((tab) => (
                <option key={tab} value={tab}>
                  {tab}
                </option>
              ))}
            </select>
          ) : (
            <input id={`${id}-tab`} value={trigger.config.tab} maxLength={100} onChange={(e) => onChange({ type: "sheets_row", config: { tab: e.target.value } })} />
          )}
        </div>
      )}
      {trigger.type === "calendar_event" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-on`}>{t("Run when")}</label>
            <select id={`${id}-on`} value={trigger.config.on} onChange={(e) => onChange({ type: "calendar_event", config: { ...trigger.config, on: e.target.value as "created" | "starting" } })}>
              <option value="created">{t("A new event is added")}</option>
              <option value="starting">{t("An event is about to start")}</option>
            </select>
          </div>
          {trigger.config.on === "starting" && (
            <div className="field">
              <label htmlFor={`${id}-before`}>{t("Minutes before the start")}</label>
              <input
                id={`${id}-before`}
                type="number"
                min={5}
                max={1440}
                value={trigger.config.minutesBefore}
                onChange={(e) => onChange({ type: "calendar_event", config: { ...trigger.config, minutesBefore: Math.round(Number(e.target.value)) || 5 } })}
              />
            </div>
          )}
        </>
      )}
      {trigger.type === "drive_file" && (
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={trigger.config.requireFile} onChange={(e) => onChange({ type: "drive_file", config: { requireFile: e.target.checked } })} />{" "}
            {t("Only run for a photo or PDF up to 5 MB")}
          </label>
        </div>
      )}
      <p className="muted hint" role="status">
        {status?.problem ? (
          <>
            {status.problem} <a href="#/apps">{t("Open Apps")}</a>
          </>
        ) : watching?.problem ? (
          watching.failures > 0 ? t("Daloy will check Google again soon. Last answer: {problem}", { problem: watching.problem }) : t("Paused: {problem}", { problem: watching.problem })
        ) : watching?.started ? (
          t("Watching {where}. Daloy checks every few minutes.", { where: status?.destination ?? "" })
        ) : status ? (
          t("Daloy checks {where} every few minutes once this is turned on. What is already there does not start a run.", { where: status.destination ?? "" })
        ) : null}
      </p>
      {trigger.type === "drive_file" && <p className="muted hint">{t("With a Google sign-in, Daloy sees only files it saved in the folder or that you picked. To watch files other people add, connect Drive with a service account key shared on the folder.")}</p>}
    </>
  );
}
