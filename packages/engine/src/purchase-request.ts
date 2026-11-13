import * as z from "zod";
import type { WorkflowDefinition } from "./definition";
import { resolveTemplate } from "./expressions";
import { OFFICE_REQUEST, setupInput } from "./office-request";

/**
 * "Purchase request with a named approver": the Microsoft office template from roadmap phase 5 (decision 0023).
 * An employee asks to buy something, gets a reference, and one named member decides in Daloy (decision 0022).
 * An approved request goes to purchasing by email, optionally from the office's Outlook mailbox and with a note in a
 * Teams channel. Without Outlook and Teams it runs on the installation's mail server, so the local demo needs neither.
 */
export const PURCHASE_REQUEST = "purchase-request";
export const PURCHASE_SETUP_STEPS = ["name", "approver", "destinations", "review"] as const;
/** A week to decide; after that the requester hears there was no decision and can ask again. */
export const PURCHASE_TIMEOUT_SECONDS = 7 * 24 * 3600;

export const purchaseRequestAnswers = z.strictObject({
  name: z.string().trim().min(1).max(200),
  approver: z.email().max(254),
  purchasingEmail: z.email().max(254),
  outlook: z.boolean().default(false),
  teams: z.boolean().default(false),
});
export type PurchaseRequestAnswers = z.input<typeof purchaseRequestAnswers>;

export const purchaseSetupInput = z.strictObject({ template: z.literal(PURCHASE_REQUEST), step: z.enum(PURCHASE_SETUP_STEPS), answers: purchaseRequestAnswers });
export type PurchaseSetup = z.infer<typeof purchaseSetupInput>;

/** Body of PATCH /workflows/:id/setup for either guided template. A body without a template is an office request, as before. */
export const guidedSetupInput = z.union([setupInput.extend({ template: z.literal(OFFICE_REQUEST).optional() }), purchaseSetupInput]);

export const defaultPurchaseAnswers = (email: string): PurchaseRequestAnswers => ({ name: "Purchase requests", approver: email, purchasingEmail: email, outlook: false, teams: false });

export const SAMPLE_PURCHASE = {
  name: "Marco Reyes",
  email: "marco.reyes@example.com",
  summary: "Ergonomic chair for the front desk",
  cost: "PHP 8,500",
  reason: "The current chair is broken and hurts my back.",
};

export function purchaseRequestDefinition(a: PurchaseRequestAnswers): WorkflowDefinition {
  // Every email except the approval request goes from the Outlook mailbox when the owner chose it. The approval request
  // stays an approval step: it carries the single-use link and goes through the Business and email sender.
  const mail = (id: string, to: string, subject: string, text: string) => ({ id, type: a.outlook ? ("outlook" as const) : ("email" as const), config: { to, subject, text } });
  const toRequester = (id: string, subject: string, body: string) => mail(id, "{{trigger.email}}", subject, `Hi {{trigger.name}},\n\n${body}\n\nReference: {{trigger.reference}}`);
  const approved = [
    mail(
      "tell_purchasing",
      a.purchasingEmail,
      "Approved purchase {{trigger.reference}}: {{trigger.summary}}",
      `${a.approver} approved this purchase request.\n\nItem: {{trigger.summary}}\nEstimated cost: {{trigger.cost}}\nRequested by: {{trigger.name}} ({{trigger.email}})\nWhy: {{trigger.reason}}\n\nReference: {{trigger.reference}}`,
    ),
    // The channel sees the reference and the item only: no name, cost or reason. It cannot approve anything.
    ...(a.teams
      ? [{ id: "post_to_teams", type: "teams" as const, config: { text: "Purchase request {{trigger.reference}} was approved: {{trigger.summary}}\nPurchasing has the details. Decisions are made in Daloy by the named approver." } }]
      : []),
    toRequester("tell_approved", "Your purchase request {{trigger.reference}} was approved", `${a.approver} approved your request for {{trigger.summary}}. Purchasing has it now.`),
  ];
  const chain = ["decide", ...approved.map((s) => s.id)];
  return {
    trigger: {
      type: "form",
      config: {
        fields: [
          { name: "name", label: "Your name", type: "text", required: true },
          { name: "email", label: "Your email", type: "email", required: true },
          { name: "summary", label: "What do you want to buy?", type: "text", required: true },
          { name: "cost", label: "Estimated cost", type: "text", required: true },
          { name: "reason", label: "Why is it needed?", type: "textarea", required: false },
        ],
      },
    },
    steps: [
      toRequester("send_receipt", "We received your purchase request {{trigger.reference}}", `We received your request for {{trigger.summary}} ({{trigger.cost}}). ${a.approver} will decide, and you will hear back by email.`),
      {
        id: "decide",
        type: "approval",
        config: {
          approver: a.approver,
          subject: "Purchase request {{trigger.reference}}: {{trigger.summary}}",
          message: "{{trigger.name}} ({{trigger.email}}) asks to buy:\n{{trigger.summary}}\nEstimated cost: {{trigger.cost}}\nWhy: {{trigger.reason}}\n\nReference: {{trigger.reference}}",
          timeoutSeconds: PURCHASE_TIMEOUT_SECONDS,
        },
      },
      ...approved,
      toRequester("tell_rejected", "Your purchase request {{trigger.reference}} was not approved", `${a.approver} did not approve your request for {{trigger.summary}}. Ask them if you want to know more.`),
      toRequester("tell_no_decision", "No decision on your purchase request {{trigger.reference}}", "Nobody decided on your request for {{trigger.summary}} within a week. Send it again if you still need it."),
    ],
    edges: [
      { from: "send_receipt", to: "decide" },
      { from: "decide", to: approved[0]!.id, on: "approved" },
      ...chain.slice(2).map((to, i) => ({ from: chain[i + 1]!, to })),
      { from: "decide", to: "tell_rejected", on: "rejected" },
      { from: "decide", to: "tell_no_decision", on: "timeout" },
    ],
  };
}

const TITLES: Record<string, string> = {
  send_receipt: "Receipt to the employee",
  decide: "Approval request to the approver",
  tell_purchasing: "Email to purchasing, once approved",
  tell_approved: "Approved, to the employee",
  tell_rejected: "Not approved, to the employee",
  tell_no_decision: "No decision after a week, to the employee",
};

/** Every message a submission can lead to, worked out with the worker's resolver. Pure: nothing is recorded or sent. */
export function previewPurchaseRequest(answers: PurchaseRequestAnswers, sample: Record<string, string>) {
  const reference = "PUR-SAMPLE";
  const ctx = { trigger: { ...sample, reference }, steps: {} };
  const text = (t: string) => String(resolveTemplate(t, ctx) ?? "");
  const messages: { title: string; via: string; to: string; subject: string; text: string }[] = [];
  let teamsMessage: string | undefined;
  for (const s of purchaseRequestDefinition(answers).steps) {
    if (s.type === "teams") teamsMessage = text(s.config.text);
    if (s.type === "email" || s.type === "outlook") {
      messages.push({ title: TITLES[s.id]!, via: s.type === "outlook" ? "Outlook" : "Email", to: text(s.config.to), subject: text(s.config.subject), text: text(s.config.text) });
    }
    if (s.type === "approval") {
      messages.push({ title: TITLES[s.id]!, via: "Daloy approval link", to: s.config.approver!, subject: text(s.config.subject), text: `${text(s.config.message)}\n\n(Approve or reject link, for ${s.config.approver} signed in)` });
    }
  }
  return { reference, messages, ...(teamsMessage ? { teamsMessage } : {}) };
}
