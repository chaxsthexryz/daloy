import type { ReactNode } from "react";
import { useLanguage } from "./Language";

/** What a step's live check says. "idle" shows nothing; "warn" is advice, not a failure. */
export type StepCheck = { state: "idle" | "busy" | "ok" | "warn" | "error"; text?: string };

/** A numbered list of setup steps. Each step has one action and an optional live result under it. */
export function GuidedSteps({ children }: { children: ReactNode }) {
  return <ol className="guided-steps">{children}</ol>;
}

export function GuidedStep({ title, check, children }: { title: string; check?: StepCheck; children?: ReactNode }) {
  const { t } = useLanguage();
  const shown = check && check.state !== "idle" ? check : null;
  return (
    <li className="guided-step">
      <h4>{t(title)}</h4>
      {children}
      {shown && (
        <p role={shown.state === "error" ? "alert" : "status"} className={`step-check ${shown.state}${shown.state === "error" ? " message error" : ""}`}>
          {shown.state === "busy" ? t("Checking…") : shown.text}
        </p>
      )}
    </li>
  );
}
