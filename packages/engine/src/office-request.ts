import * as z from "zod";
import type { FormField, WorkflowDefinition } from "./definition";
import { resolveTemplate } from "./expressions";

/**
 * "Track an office request": the guided template from the business automation roadmap, phase 1.
 * Staff fill in a form, the API records a request with a reference, the office gets a notification
 * and the employee a receipt. No AI step, so it works with AI disabled.
 */
export const OFFICE_REQUEST = "office-request";

/** The guided setup screens, in order. The workflow's setup column stores the one the owner reached. */
export const SETUP_STEPS = ["name", "fields", "destinations", "review"] as const;

const EXTRA_FIELDS = {
  location: { name: "location", label: "Where is it?", type: "text", required: false },
  details: { name: "details", label: "Anything else we should know?", type: "textarea", required: false },
} satisfies Record<string, FormField>;

export const officeRequestAnswers = z.strictObject({
  name: z.string().trim().min(1).max(200),
  notifyEmail: z.email().max(254),
  extraFields: z.array(z.enum(["location", "details"])).max(2),
});
export type OfficeRequestAnswers = z.infer<typeof officeRequestAnswers>;

/** Body of PATCH /workflows/:id/setup. */
export const setupInput = z.strictObject({ step: z.enum(SETUP_STEPS), answers: officeRequestAnswers });
export type Setup = z.infer<typeof setupInput> & { template: typeof OFFICE_REQUEST };

export const defaultAnswers = (notifyEmail: string): OfficeRequestAnswers => ({ name: "Office requests", notifyEmail, extraFields: ["location"] });

export const SAMPLE_REQUEST = {
  name: "Rosa Diaz",
  email: "rosa.diaz@example.com",
  summary: "The printer on floor 2 is jammed.",
  location: "Floor 2, near the pantry",
  details: "It shows error E-04 and nobody can print.",
};

function lines(answers: OfficeRequestAnswers) {
  const extra = { location: "Where: {{trigger.location}}", details: "Details: {{trigger.details}}" };
  return answers.extraFields.map((f) => extra[f]).join("\n");
}

export function officeRequestDefinition(answers: OfficeRequestAnswers): WorkflowDefinition {
  const more = lines(answers);
  return {
    trigger: {
      type: "form",
      config: {
        fields: [
          { name: "name", label: "Your name", type: "text", required: true },
          { name: "email", label: "Your email", type: "email", required: true },
          { name: "summary", label: "What needs attention?", type: "text", required: true },
          ...answers.extraFields.map((f) => EXTRA_FIELDS[f]),
        ],
      },
    },
    steps: [
      {
        id: "notify_office",
        type: "email",
        config: {
          to: answers.notifyEmail,
          subject: "New request {{trigger.reference}}: {{trigger.summary}}",
          text: `{{trigger.name}} ({{trigger.email}}) sent a request.\n\n{{trigger.summary}}${more ? `\n${more}` : ""}\n\nReference: {{trigger.reference}}`,
        },
      },
      {
        id: "send_receipt",
        type: "email",
        config: {
          to: "{{trigger.email}}",
          subject: "We received your request {{trigger.reference}}",
          text: `Hi {{trigger.name}},\n\nWe received your request: {{trigger.summary}}\nYour reference is {{trigger.reference}}. Quote it if you ask about this request.`,
        },
      },
    ],
    edges: [{ from: "notify_office", to: "send_receipt" }],
  };
}

/**
 * What a submission would produce, worked out here with the same template resolver the worker uses.
 * Pure: no run, no request record and no email, so a preview cannot reach anyone.
 */
export function previewOfficeRequest(answers: OfficeRequestAnswers, sample: Record<string, string>) {
  const reference = "REQ-SAMPLE";
  const ctx = { trigger: { ...sample, reference }, steps: {} };
  const [notify, receipt] = officeRequestDefinition(answers).steps.map((s) => {
    const c = s.config as { to: string; subject: string; text: string };
    return { to: String(resolveTemplate(c.to, ctx)), subject: String(resolveTemplate(c.subject, ctx)), text: String(resolveTemplate(c.text, ctx)) };
  });
  return { reference, record: { reference, subject: sample.summary ?? "", list: answers.name }, notification: notify!, receipt: receipt! };
}
