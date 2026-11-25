import { explainFailureTl, answerAllTl } from "./explain-tl";
import type { WorkflowDefinition } from "@daloy/engine";
import { lintFindings, type LintRule } from "@daloy/engine";

/**
 * Plain-language explanations of failed runs (phase N10a). failureFacts keeps only closed-set or numeric fields, so the
 * facts can go to a model without any error text, step id, label, URL, address or payload.
 */
export type Reason = "mail_sender" | "ai_model" | "quota" | "booking_changed" | "worker_stopped" | "preview_choice";
export type Facts = {
  runState: string;
  preview: boolean;
  step: { type: string; outcome: string | null; attempts: number; deadLetter: boolean; statusCode: number | null; reason: Reason | null } | null;
  deliveries: { provider: string; state: string; errorKind: string | null; attempts: number }[];
  lint: { rule: LintRule; count: number }[];
};
export type Question = "happened" | "why" | "next";
export type AskFacts = Facts & {
  plainState: "needs you" | "problem" | "waiting" | "done" | "in progress";
  steps: { type: string; state: string; outcome: string | null; attempts: number }[];
};
export type Explanation = { headline: string; lines: string[]; fix: { href: string; label: string } | null };
type FactsInput = {
  run: { state: string; test: boolean; error?: string | null };
  steps: { stepId: string; attempt: number; state: string; error?: string | null; deadLetter: boolean; outcome: string | null; branch?: string | null; createdAt?: Date | string | null }[];
  deliveries: { provider: string; state: string; errorKind: string | null; attempts: number }[];
  definition: unknown;
};

// First match wins. Each pattern is the real message text the API, worker or db writes.
const REASONS: [Reason, RegExp][] = [
  ["mail_sender", /gmail|mail server/i],
  ["ai_model", /api key|ai model/i],
  ["quota", /AI actions for this month|SMS messages for this month|SMS sending is not included|limit of \d+ (email recipients|web requests)/i],
  ["booking_changed", /booking was rescheduled or cancelled/i],
  ["worker_stopped", /worker stopped while sending/i],
  ["preview_choice", /^Test run: this step was set to fail/],
];

const time = (s: FactsInput["steps"][number]) => (s.createdAt ? new Date(s.createdAt).getTime() : 0);
const stuck = (state: string) => state === "failed" || state === "needs_review";

export function failureFacts({ run, steps, deliveries, definition }: FactsInput): Facts {
  const def = definition as Partial<WorkflowDefinition> | null;
  // A failure that took its failed path (T3) is handled, so it is not why the run stopped.
  const failed = steps.filter((s) => (s.state === "failed" && s.branch !== "failed") || s.state === "needs_review").sort((a, b) => time(b) - time(a) || b.attempt - a.attempt)[0];
  const text = failed?.error ?? run.error ?? "";
  const reason = REASONS.find(([, re]) => re.test(text))?.[0] ?? null;
  let lint: Facts["lint"] = [];
  try {
    const counts = new Map<LintRule, number>();
    for (const f of lintFindings(definition as WorkflowDefinition)) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
    lint = [...counts].map(([rule, count]) => ({ rule, count }));
  } catch {
    // A definition that cannot be checked has no findings.
  }
  return {
    runState: run.state,
    preview: run.test,
    step: failed
      ? {
          type: def?.steps?.find((s) => s.id === failed.stepId)?.type ?? "unknown",
          outcome: failed.outcome,
          attempts: Math.max(...steps.filter((s) => s.stepId === failed.stepId).map((s) => s.attempt)),
          deadLetter: failed.deadLetter,
          statusCode: Number(/^(?:step [^:]*: )?HTTP (\d{3}) from /.exec(failed.error ?? "")?.[1]) || null,
          reason,
        }
      : null,
    deliveries: deliveries.filter((d) => d.state === "failed" || d.state === "needs_review" || (d.state === "queued" && d.errorKind)).map((d) => ({ provider: d.provider, state: d.state, errorKind: d.errorKind, attempts: d.attempts })),
    lint,
  };
}

/** failureFacts plus the plain state (as apps/web/src/lib/states.ts) and a timeline of step types. Still no ids, labels or text. */
export function askFacts(input: FactsInput): AskFacts {
  const def = input.definition as Partial<WorkflowDefinition> | null;
  const { run, deliveries } = input;
  const latest = new Map<string, FactsInput["steps"][number]>();
  for (const s of [...input.steps].sort((a, b) => time(a) - time(b) || a.attempt - b.attempt)) latest.set(s.stepId, s);
  const plainState =
    run.state === "needs_review" || deliveries.some((d) => d.state === "needs_review") ? "needs you"
    : run.state === "failed" || deliveries.some((d) => d.state === "failed") ? "problem"
    : run.state === "waiting" ? "waiting"
    : run.state === "succeeded" || run.state === "cancelled" ? "done"
    : "in progress";
  const steps = [...latest.values()].map((s) => ({ type: def?.steps?.find((d) => d.id === s.stepId)?.type ?? "unknown", state: s.state, outcome: s.outcome, attempts: s.attempt }));
  return { ...failureFacts(input), plainState, steps };
}

const APPS: Record<string, string> = { google_sheets: "Google Sheets", slack: "Slack", outlook: "Outlook", teams: "Microsoft Teams", discord: "Discord", telegram: "Telegram", unisms: "UniSMS", google_calendar: "Google Calendar", google_drive: "Google Drive", airtable: "Airtable", notion: "Notion", trello: "Trello", meta_messenger: "Facebook Messenger & Instagram", shopify: "Shopify" };
const APPS_FIX = { href: "#/apps", label: "Check the connection" };
// Retry, Send again and Mark as posted are on the run page itself, so these need no link.
const ACTIVITY_FIX = null;
const LINT_LINES: Record<LintRule, string> = {
  approval_no_edge: "An approval in this automation has no path for one of its answers, so the automation ends there.",
  classify_dead_end: "An AI sort in this automation can give an answer that leads nowhere, so the automation ends there.",
  test_switch: "This automation has a switch that looks like a test setting. Check that it is set the way you want.",
  number_no_invalid: "A number check in this automation has no path for a value that is not a number, so the automation ends there.",
  unreachable_step: "Part of this automation can never be reached, so it will not run.",
  failed_path_no_edge: "A step in this automation is set to take a failed path, but none is drawn, so a failure stops the automation.",
};
const PERMISSION: Record<string, string> = {
  google_calendar: "Share the calendar with the Google service account you connected, choose Make changes to events, then press Retry.",
  google_sheets: "Share the sheet with the Google account you connected, then press Retry.",
  slack: "Invite the kymavo app to the channel, then press Retry.",
  outlook: "Check that the connected Outlook account may send email, then press Retry.",
  teams: "Add the connected account to the team and channel, then press Retry.",
  discord: "Check that the channel still allows the webhook, or paste a new webhook link in Apps, then press Retry.",
  airtable: "Give the Airtable token access to that base and table, then press Retry.",
  notion: "Share the database with the Notion integration, then press Retry.",
  trello: "Make sure the Trello token can edit that board, then press Retry.",
  meta_messenger: "Check the Page messaging permissions in Meta, then press Retry.",
};

function ofDelivery(d: Facts["deliveries"][number]): Explanation | null {
  const app = APPS[d.provider] ?? "The other app";
  const sent = d.provider === "outlook" || d.provider === "unisms" || d.provider === "meta_messenger";
  const where = d.provider === "google_sheets" ? "sheet" : d.provider === "google_calendar" ? "calendar" : d.provider === "unisms" ? "Sender ID" : d.provider === "meta_messenger" ? "page" : "channel";
  const done = sent ? "Mark as sent" : "Mark as posted";
  const again = sent ? "Send again" : "Post again";
  const check = d.provider === "outlook" ? "Check Sent Items" : `Check ${app}`;
  const review = (why: string) => ({ headline: "This needs you before it goes on.", lines: [why, `${check}. If it is there, press ${done}. If not, press ${again}.`], fix: ACTIVITY_FIX });
  switch (d.errorKind) {
    case "auth":
    case "reconnect":
      return { headline: `${app} needs to be connected again.`, lines: [`${app} no longer accepts kymavo's access. Reconnect it in Apps, then press Retry.`], fix: APPS_FIX };
    case "not_connected":
      return { headline: `${app} is not connected.`, lines: [`Connect ${app} in Apps, then press Retry.`], fix: { href: "#/apps", label: `Connect ${app}` } };
    case "permission":
      return { headline: `${app} refused kymavo.`, lines: [PERMISSION[d.provider] ?? "Give the connected account access, then press Retry."], fix: APPS_FIX };
    case "no_destination":
      return { headline: `No ${where} is chosen for ${app}.`, lines: [`Pick a ${where} in Apps, then press Retry.`], fix: { href: "#/apps", label: `Pick a ${where}` } };
    case "plan_quota":
      return { headline: "The plan limit was reached.", lines: ["This office used up what its plan allows for now. Press Retry when the limit resets."], fix: { href: "#/settings", label: "See usage" } };
    case "quota":
    case "unavailable":
      return { headline: `${app} is busy or limiting requests.`, lines: [`kymavo will try again on its own. Nothing needs to be done now (${d.attempts} ${d.attempts === 1 ? "try" : "tries"} so far).`], fix: null };
    case "ambiguous":
    case "review":
      return review(`${app} did not say clearly whether this went through.`);
    case "destination_changed":
      return review(`The ${where} for ${app} was changed after this was queued, so kymavo did not send it.`);
    case "queued_before_pin":
      return review(`This was queued before kymavo recorded which ${where} to use, so kymavo did not send it.`);
    case "invalid":
      return { headline: `${app} rejected this.`, lines: [`${app} did not accept what kymavo sent. Check this step's settings in the automation.`], fix: null };
    case "booking_changed":
      return { headline: "This was closed because the booking changed.", lines: ["The booking was rescheduled or cancelled, so nothing more is sent."], fix: null };
    default:
      return null;
  }
}

function ofStep(s: NonNullable<Facts["step"]>): Explanation | null {
  switch (s.reason) {
    case "mail_sender":
      return { headline: "The email could not be sent.", lines: ["kymavo could not use the connected email account. Connect Gmail again, then press Retry."], fix: { href: "#/apps", label: "Connect Gmail" } };
    case "ai_model":
      return { headline: "The AI model did not answer.", lines: ["kymavo could not reach the AI model, or its key was refused. Check the AI model, then press Retry."], fix: { href: "#/settings/ai", label: "Check the AI model" } };
    case "quota":
      return { headline: "The plan limit was reached.", lines: ["This office used up what its plan allows for now. Press Retry when the limit resets."], fix: { href: "#/settings", label: "See usage" } };
    case "booking_changed":
      return { headline: "This was closed because the booking changed.", lines: ["The booking was rescheduled or cancelled, so nothing more is sent."], fix: null };
    case "worker_stopped":
      return { headline: "kymavo stopped while sending.", lines: ["This may have gone through. Check with the receiver, then choose It went through, Send again or Stop."], fix: ACTIVITY_FIX };
    case "preview_choice":
      return { headline: "This preview was set to fail on purpose.", lines: ["Nothing was sent. Change the preview choice to see the automation go on."], fix: null };
  }
  const code = s.statusCode;
  const http = code === 401 || code === 403 ? "the other service refused kymavo's access" : code === 404 ? "the address was not found" : code === 429 ? "the other service asked kymavo to slow down" : code && code >= 500 ? "the other service had a problem" : null;
  if (http) return { headline: `A request failed: ${http}.`, lines: [`The other service answered ${code}. ${s.deadLetter ? `kymavo tried ${s.attempts} times. ` : ""}Check the request settings, then press Retry.`], fix: ACTIVITY_FIX };
  if (s.deadLetter) return { headline: "kymavo gave up after trying again.", lines: [`The step failed ${s.attempts} times, so kymavo stopped trying. Press Retry when the cause is fixed.`], fix: ACTIVITY_FIX };
  if (s.outcome === "unknown") return { headline: "It is not clear whether this went through.", lines: ["Check with the receiver, then choose It went through, Send again or Stop."], fix: ACTIVITY_FIX };
  if (s.outcome === "not_sent") return { headline: "Nothing was sent.", lines: ["kymavo stopped before the request left. Press Retry to try again."], fix: ACTIVITY_FIX };
  if (s.outcome === "rejected") return { headline: "The other service rejected the request.", lines: ["Check the step's settings in the automation, then press Retry."], fix: null };
  if (s.outcome === "throttled") return { headline: "The other service asked kymavo to slow down.", lines: ["Press Retry in a few minutes."], fix: null };
  return null;
}

/** A fixed table, first match wins: deliveries, then the step, then one line per lint rule. No model involved. */
export function explainFailure(facts: Facts, language: "en" | "tl" = "en"): Explanation {
  if (language === "tl") return explainFailureTl(facts);
  const first = facts.deliveries.map(ofDelivery).find(Boolean) ?? (facts.step ? ofStep(facts.step) : null);
  const base = first ?? { headline: "kymavo could not tell why this stopped.", lines: ["The details for a technician below have the full record."], fix: null };
  return { ...base, lines: [...base.lines, ...facts.lint.map((l) => LINT_LINES[l.rule])] };
}

// The console's names for step types (apps/web/src/FlowCanvas.tsx TYPE_NAMES), plus booking.
const TYPE_NAMES: Record<string, string> = { condition: "Condition", switch: "Switch", transform: "Transform", http: "HTTP request", browser: "Use a web page", email: "Send email", delay: "Delay", ai: "AI task", approval: "Approval", sheets: "Add to Google Sheets", drive: "Save files to Google Drive", slack: "Post to Slack", outlook: "Send from Outlook", teams: "Post to Teams", discord: "Post to Discord", google_docs: "Make a Google Docs document", read_spreadsheet: "Read a spreadsheet from Google Drive", read_page: "Read a web page", telegram: "Send to Telegram", sms: "Send SMS", calendar: "Add to Google Calendar", paymongo_link: "Create payment link", payment_status: "Check payment", airtable: "Add to Airtable", notion: "Add to Notion", trello: "Add to Trello", booking: "Booking", meta_reply: "Reply on Messenger or Instagram", conversation_update: "Save guest details", stay_quote: "Quote a stay", shopify_create_product: "Create a Shopify product", shopify_update_product: "Update a Shopify product", payment_due: "Ask for payment", payment_expire: "Cancel if unpaid", call_workflow: "Call another automation" };
const HEADLINES = { "needs you": "This request needs you before it goes on.", done: "This request is done.", problem: "This request stopped with a problem.", waiting: "This request is waiting.", "in progress": "This request is still going." };
const OPEN_ACTIVITY = "Open the request in Activity to see every step.";

/** The three fixed answers for the Ask panel. Every word is from a table above or a closed field. */
export function answerAll(facts: AskFacts, language: "en" | "tl" = "en"): { happened: Explanation; why: Explanation | null; next: Explanation } {
  if (language === "tl") return answerAllTl(facts);
  const n = facts.steps.length;
  const happened = [n ? `${n} ${n === 1 ? "step" : "steps"} ran.` : "No steps have run yet."];
  if (facts.step) happened.push(`It stopped at: ${TYPE_NAMES[facts.step.type] ?? "a step"}.`);
  const why = stuck(facts.runState) || facts.deliveries.some((d) => stuck(d.state)) ? explainFailure(facts) : null;
  const next = why
    ? { headline: "What to do next.", lines: [...why.lines, OPEN_ACTIVITY], fix: why.fix }
    : { headline: "What to do next.", lines: ["Nothing needs to be done.", ...facts.lint.map((l) => LINT_LINES[l.rule]), OPEN_ACTIVITY], fix: null };
  return { happened: { headline: HEADLINES[facts.plainState], lines: happened, fix: null }, why, next };
}
