import { useEffect, useId, useState } from "react";
import type { Trigger } from "@daloy/engine";
import { api } from "./api";
import { useLanguage } from "./Language";

/** G5 (decision 0134): settings and status of an Airtable, Notion or Trello trigger in the editor. */
export type RecordTrigger = Extract<Trigger, { type: "airtable_record" | "notion_page" | "trello_card" }>;
type Status = {
  app: string;
  problem: string | null;
  destination: string | null;
  watching: { problem: string | null; failures: number; started: boolean; lastPolledAt: string | null } | null;
};

const APP_LABEL: Record<RecordTrigger["type"], string> = {
  airtable_record: "Airtable",
  notion_page: "Notion",
  trello_card: "Trello",
};

export function RecordTriggerSettings({ trigger, workflowId, onChange }: { trigger: RecordTrigger; workflowId: string; onChange: (t: Trigger) => void }) {
  const { t } = useLanguage();
  const id = useId();
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ workflowId });
    api<Status>("GET", `/triggers/records/${trigger.type}?${q}`)
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [trigger.type, workflowId]);

  const watching = status?.watching;
  const appName = APP_LABEL[trigger.type];
  return (
    <>
      {trigger.type === "airtable_record" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-on`}>{t("Run when")}</label>
            <select
              id={`${id}-on`}
              value={trigger.config.on}
              onChange={(e) => {
                const on = e.target.value as "created" | "status_changed";
                onChange({
                  type: "airtable_record",
                  config: on === "status_changed" ? { on, statusField: trigger.config.statusField ?? "Status" } : { on },
                });
              }}
            >
              <option value="created">{t("A new record is added")}</option>
              <option value="status_changed">{t("A status field changes")}</option>
            </select>
          </div>
          {trigger.config.on === "status_changed" && (
            <div className="field">
              <label htmlFor={`${id}-status-field`}>{t("Status field")}</label>
              <input
                id={`${id}-status-field`}
                value={trigger.config.statusField ?? "Status"}
                maxLength={100}
                onChange={(e) => onChange({ type: "airtable_record", config: { on: "status_changed", statusField: e.target.value } })}
              />
            </div>
          )}
        </>
      )}
      {trigger.type === "notion_page" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-on`}>{t("Run when")}</label>
            <select
              id={`${id}-on`}
              value={trigger.config.on}
              onChange={(e) => {
                const on = e.target.value as "created" | "status_changed";
                onChange({
                  type: "notion_page",
                  config: on === "status_changed" ? { on, statusProperty: trigger.config.statusProperty ?? "Status" } : { on },
                });
              }}
            >
              <option value="created">{t("A new page is added")}</option>
              <option value="status_changed">{t("A status property changes")}</option>
            </select>
          </div>
          {trigger.config.on === "status_changed" && (
            <div className="field">
              <label htmlFor={`${id}-status-prop`}>{t("Status property")}</label>
              <input
                id={`${id}-status-prop`}
                value={trigger.config.statusProperty ?? "Status"}
                maxLength={100}
                onChange={(e) => onChange({ type: "notion_page", config: { on: "status_changed", statusProperty: e.target.value } })}
              />
            </div>
          )}
        </>
      )}
      {trigger.type === "trello_card" && (
        <div className="field">
          <label htmlFor={`${id}-on`}>{t("Run when")}</label>
          <select
            id={`${id}-on`}
            value={trigger.config.on}
            onChange={(e) => onChange({ type: "trello_card", config: { on: e.target.value as "created" | "moved_to_list" } })}
          >
            <option value="created">{t("A new card is added to the list")}</option>
            <option value="moved_to_list">{t("A card moves into the list")}</option>
          </select>
        </div>
      )}
      <p className="muted hint" role="status">
        {status?.problem ? (
          <>
            {status.problem} <a href="#/apps">{t("Open Apps")}</a>
          </>
        ) : watching?.problem ? (
          watching.failures > 0 ? (
            t("kymavo will check {app} again soon. Last answer: {problem}", { app: appName, problem: watching.problem })
          ) : (
            t("Paused: {problem}", { problem: watching.problem })
          )
        ) : watching?.started ? (
          t("Watching {where}. kymavo checks every few minutes.", { where: status?.destination ?? "" })
        ) : status ? (
          t("kymavo checks {where} every few minutes once this is turned on. What is already there does not start a run.", { where: status.destination ?? "" })
        ) : null}
      </p>
    </>
  );
}
