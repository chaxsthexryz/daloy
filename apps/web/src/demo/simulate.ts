import { conditionBranch, entryStep, nextStep, resolveTemplate, type WorkflowDefinition } from "@daloy/engine";

export type Message = { kind: "email" | "approval" | "sheets" | "slack"; to: string; subject: string; text: string };
export type SimStep = { stepId: string; state: "succeeded" | "waiting"; branch: string | null; message?: Message; note?: string };
export type SimRun = { state: "succeeded" | "waiting"; reference: string; steps: SimStep[] };

export const DEMO_REFERENCE = "REQ-DEMO1";

/**
 * Walks a definition the way the worker would, in the browser and without sending anything: templates are resolved with
 * the engine's resolver, conditions take the engine's branch, and an approval waits until `decisions` answers it.
 * Delays are skipped and say so. Pure, so the page replays it one step at a time.
 */
export function simulate(def: WorkflowDefinition, trigger: Record<string, unknown>, decisions: Record<string, "approved" | "rejected">): SimRun {
  const ctx = { trigger: { ...trigger, reference: DEMO_REFERENCE }, steps: {} };
  const text = (t: string) => String(resolveTemplate(t, ctx) ?? "");
  const steps: SimStep[] = [];
  let step: WorkflowDefinition["steps"][number] | undefined = entryStep(def);
  while (step) {
    let row: SimStep = { stepId: step.id, state: "succeeded", branch: null };
    switch (step.type) {
      case "email":
      case "outlook":
        row.message = { kind: "email", to: text(step.config.to), subject: text(step.config.subject), text: text(step.config.text) };
        break;
      case "sheets":
        row.message = { kind: "sheets", to: "Google Sheet", subject: "New row", text: [DEMO_REFERENCE, "(time of the run)", ...step.config.columns.map(text)].join(" | ") };
        break;
      case "slack":
      case "teams":
        row.message = { kind: "slack", to: step.type === "slack" ? "Slack channel" : "Teams channel", subject: "New message", text: text(step.config.text) };
        break;
      case "delay":
        row.note = "The wait is skipped in the demo. Daloy would hold the run until then.";
        break;
      case "condition":
        row.branch = conditionBranch(step.config.condition, ctx);
        break;
      case "approval": {
        const message: Message = { kind: "approval", to: step.config.to ? text(step.config.to) : (step.config.approver ?? ""), subject: text(step.config.subject), text: text(step.config.message) };
        const decision = decisions[step.id];
        row = decision ? { ...row, branch: decision, message } : { ...row, state: "waiting", message };
        break;
      }
      default:
        throw new Error(`${step.type} steps are not part of the demo`);
    }
    steps.push(row);
    if (row.state === "waiting") return { state: "waiting", reference: DEMO_REFERENCE, steps };
    step = nextStep(def, step.id, row.branch ?? undefined);
  }
  return { state: "succeeded", reference: DEMO_REFERENCE, steps };
}
