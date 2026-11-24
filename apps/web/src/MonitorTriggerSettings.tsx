import { useEffect, useId, useState } from "react";
import { READ_PAGE_MAX_CHARS, type Trigger } from "@daloy/engine";
import { api } from "./api";
import { useLanguage } from "./Language";

/** G4 (decision 0133): settings and watcher status for the `page_changed` trigger in the editor. */
export type MonitorTrigger = Extract<Trigger, { type: "page_changed" }>;

type MonitorStatus = {
  watching: { problem: string | null; failures: number; started: boolean; lastPolledAt: string | null } | null;
  http: { used: number; limit: number | null };
};

export function MonitorTriggerSettings({
  trigger,
  workflowId,
  onChange,
}: {
  trigger: MonitorTrigger;
  workflowId: string;
  onChange: (t: Trigger) => void;
}) {
  const { t } = useLanguage();
  const id = useId();
  const [status, setStatus] = useState<MonitorStatus | null>(null);

  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ workflowId });
    api<MonitorStatus>("GET", `/triggers/monitor?${q}`)
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [workflowId]);

  const watching = status?.watching;
  const { mode, url, selector, maxChars } = trigger.config;

  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-mode`}>{t("Monitor kind")}</label>
        <select
          id={`${id}-mode`}
          value={mode}
          onChange={(e) => {
            const nextMode = e.target.value as "page" | "feed";
            onChange({
              type: "page_changed",
              config: {
                url,
                mode: nextMode,
                ...(nextMode === "page" && selector ? { selector } : {}),
                maxChars,
              },
            });
          }}
        >
          <option value="page">{t("Public web page")}</option>
          <option value="feed">{t("RSS or Atom feed")}</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-url`}>{t("Web address to watch")}</label>
        <input
          id={`${id}-url`}
          type="url"
          value={url}
          maxLength={2000}
          placeholder={mode === "feed" ? "https://example.com/feed.xml" : "https://example.com/prices"}
          onChange={(e) => onChange({ type: "page_changed", config: { ...trigger.config, url: e.target.value } })}
        />
      </div>
      {mode === "page" && (
        <div className="field">
          <label htmlFor={`${id}-selector`}>
            {t("CSS selector")} <span className="muted">{t("(optional)")}</span>
          </label>
          <input
            id={`${id}-selector`}
            value={selector ?? ""}
            maxLength={500}
            placeholder=".price"
            onChange={(e) =>
              onChange({
                type: "page_changed",
                config: { ...trigger.config, selector: e.target.value || undefined },
              })
            }
          />
          <p className="muted hint">{t("Leave empty to watch the whole page text, or enter a selector like .price to watch one value.")}</p>
        </div>
      )}
      <div className="field">
        <label htmlFor={`${id}-chars`}>{t("Most characters to keep")}</label>
        <input
          id={`${id}-chars`}
          type="number"
          min={100}
          max={READ_PAGE_MAX_CHARS}
          value={maxChars}
          onChange={(e) =>
            onChange({
              type: "page_changed",
              config: { ...trigger.config, maxChars: Math.min(READ_PAGE_MAX_CHARS, Math.max(100, Math.round(Number(e.target.value)) || 4000)) },
            })
          }
        />
      </div>
      <p className="muted hint" role="status">
        {watching?.problem ? (
          watching.failures > 0
            ? t("kymavo will check the page again soon. Last answer: {problem}", { problem: watching.problem })
            : t("Paused: {problem}", { problem: watching.problem })
        ) : watching?.started ? (
          t("Watching this address. kymavo checks every few minutes.")
        ) : (
          t("kymavo checks this public address every few minutes once turned on. The first check only records what is there now.")
        )}
      </p>
      {status?.http && status.http.limit !== null && (
        <p className="muted hint">
          {t("Each check counts against your daily web requests ({used} of {limit} used today).", {
            used: status.http.used,
            limit: status.http.limit,
          })}
        </p>
      )}
    </>
  );
}
