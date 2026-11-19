import type { Language } from "./language";
import { localizeGeneratedDefinition } from "./template-language";
import * as z from "zod";
import type { WorkflowDefinition } from "./definition";

/**
 * "Reply to a website inquiry": the business automation roadmap, phase 2. A visitor fills in the hosted form behind the
 * website's contact button. The customer gets a reply from the owner's own sender and the business inbox a notification.
 * No AI step, so it works with AI disabled.
 */
export const WEBSITE_INQUIRY = "website-inquiry";
export const WEBSITE_INQUIRY_SLUG = "website-inquiries";

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optionalEmail = z.preprocess(blankToNull, z.email().max(254).nullable());

/** Body of PUT /settings/email/profile. Blank answers are stored as null. */
export const profileInput = z.strictObject({
  // Braces would become placeholders in the templates below, and line breaks could add a mail header.
  businessName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^{}\r\n]+$/, "leave out braces and line breaks"),
  // Business information only: saving it connects no existing website form.
  website: z.preprocess(blankToNull, z.url({ protocol: /^https?$/ }).max(500).nullable()),
  inquiryEmail: optionalEmail,
  replyTo: optionalEmail,
});
export type ProfileInput = z.infer<typeof profileInput>;

/** Body of PUT /settings/email/gmail. Google shows a 16-letter app password in groups of four; the spaces are not part of it. */
export const gmailInput = z.strictObject({
  address: z.email().max(254).transform((a) => a.trim().toLowerCase()),
  appPassword: z
    .string()
    .transform((p) => p.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^[A-Za-z]{16}$/, "use the 16-letter app password from your Google account, not your Gmail password")),
});

export function websiteInquiryDefinition({ businessName, inquiryEmail }: { businessName: string; inquiryEmail: string }, language: Language = "en"): WorkflowDefinition {
  return localizeGeneratedDefinition({
    trigger: {
      type: "form",
      config: {
        fields: [
          { name: "name", label: "Your name", type: "text", required: true },
          { name: "email", label: "Your email", type: "email", required: true },
          { name: "message", label: "How can we help?", type: "textarea", required: true },
        ],
      },
    },
    steps: [
      {
        id: "reply_to_customer",
        type: "email",
        config: {
          to: "{{trigger.email}}",
          subject: `Thanks for contacting ${businessName}`,
          text: `Thanks for writing to ${businessName}. We received your message and will reply within one working day.`,
        },
      },
      {
        id: "notify_business",
        type: "email",
        config: {
          to: inquiryEmail,
          subject: "New website inquiry from {{trigger.name}}",
          text: "{{trigger.name}} ({{trigger.email}}) wrote through the website form:\n\n{{trigger.message}}\n\nReply to: {{trigger.email}}",
        },
      },
    ],
    edges: [{ from: "reply_to_customer", to: "notify_business" }],
  }, language, WEBSITE_INQUIRY, { businessName });
}
