import { useEffect, useId, useState } from "react";
import type { Trigger } from "@daloy/engine";
import { api } from "./api";
import { useLanguage } from "./Language";

/** G3 (decision 0132): filters and watcher status for a connected Gmail or Outlook mailbox trigger in the editor. */
export type MailboxTrigger = Extract<Trigger, { type: "gmail_message" | "outlook_message" }>;

type Status = {
  app: string;
  problem: string | null;
  account: string | null;
  watching: { problem: string | null; failures: number; started: boolean; lastPolledAt: string | null } | null;
};

export function MailboxTriggerSettings({ trigger, workflowId, onChange }: { trigger: MailboxTrigger; workflowId: string; onChange: (t: Trigger) => void }) {
  const { t } = useLanguage();
  const id = useId();
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ workflowId });
    api<Status>("GET", `/triggers/mailbox/${trigger.type}?${q}`)
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [trigger.type, workflowId]);

  const setFilter = (patch: Record<string, string | undefined>) => {
    if (trigger.type === "gmail_message") {
      onChange({ type: "gmail_message", config: { ...trigger.config, ...patch } });
    } else {
      onChange({ type: "outlook_message", config: { ...trigger.config, ...patch } });
    }
  };

  const watching = status?.watching;
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-from`}>
          {t("From contains")} <span className="muted">{t("(optional)")}</span>
        </label>
        <input
          id={`${id}-from`}
          value={trigger.config.from ?? ""}
          maxLength={254}
          placeholder="orders@example.com"
          onChange={(e) => setFilter({ from: e.target.value || undefined })}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-subject`}>
          {t("Subject contains")} <span className="muted">{t("(optional)")}</span>
        </label>
        <input
          id={`${id}-subject`}
          value={trigger.config.subjectContains ?? ""}
          maxLength={200}
          placeholder={t("Invoice")}
          onChange={(e) => setFilter({ subjectContains: e.target.value || undefined })}
        />
      </div>
      {trigger.type === "gmail_message" && (
        <div className="field">
          <label htmlFor={`${id}-label`}>
            {t("Gmail label")} <span className="muted">{t("(optional)")}</span>
          </label>
          <input
            id={`${id}-label`}
            value={trigger.config.label ?? ""}
            maxLength={100}
            placeholder="INBOX"
            onChange={(e) => setFilter({ label: e.target.value || undefined })}
          />
        </div>
      )}
      {trigger.type === "outlook_message" && (
        <div className="field">
          <label htmlFor={`${id}-folder`}>
            {t("Outlook folder")} <span className="muted">{t("(optional)")}</span>
          </label>
          <input
            id={`${id}-folder`}
            value={trigger.config.folder ?? ""}
            maxLength={100}
            placeholder="Inbox"
            onChange={(e) => setFilter({ folder: e.target.value || undefined })}
          />
        </div>
      )}
      <p className="muted hint" role="status">
        {status?.problem ? (
          <>
            {status.problem} <a href="#/apps">{t("Open Apps")}</a>
          </>
        ) : watching?.problem ? (
          watching.failures > 0 ? t("kymavo will check your mailbox again soon. Last answer: {problem}", { problem: watching.problem }) : t("Paused: {problem}", { problem: watching.problem })
        ) : watching?.started ? (
          t("Watching {where}. kymavo checks every few minutes.", { where: status?.account ?? "" })
        ) : status ? (
          t("kymavo checks {where} every few minutes once this is turned on. What is already there does not start a run.", { where: status.account ?? "" })
        ) : null}
      </p>
    </>
  );
}
