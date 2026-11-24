import * as z from "zod";
import { aiConfigSchema } from "./ai";
import { browserConfigSchema } from "./browser";
import { approvalConfigSchema, assistantReadConfigSchema, callWorkflowConfigSchema, discordConfigSchema, googleDocsConfigSchema, readPageConfigSchema, bookingConfigSchema, calendarConfigSchema, conditionSchema, delayConfigSchema, driveConfigSchema, emailConfigSchema, httpConfigSchema, metaReplyConfigSchema, conversationUpdateConfigSchema, stayQuoteConfigSchema, outlookConfigSchema, paymentDueConfigSchema, paymentExpireConfigSchema, paymentStatusConfigSchema, paymongoLinkConfigSchema, shopifyCreateProductConfigSchema, shopifyUpdateProductConfigSchema, airtableConfigSchema, notionConfigSchema, trelloConfigSchema, sheetsConfigSchema, slackConfigSchema, smsConfigSchema, switchConfigSchema, teamsConfigSchema, telegramConfigSchema, transformConfigSchema, type Step } from "./definition";

/**
 * JSON Schema for each step type's config, which the builder turns into a form.
 * io "input" describes what the user types, so fields with defaults are optional.
 * Refinements (such as the 20-header cap) are not in the JSON; the API still enforces them on save.
 */
export function stepJsonSchemas(): Record<Step["type"], unknown> {
  const json = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" });
  return {
    condition: json(z.object({ condition: conditionSchema })),
    switch: json(switchConfigSchema),
    transform: json(transformConfigSchema),
    http: json(httpConfigSchema),
    email: json(emailConfigSchema),
    delay: json(delayConfigSchema),
    ai: json(aiConfigSchema),
    approval: json(approvalConfigSchema),
    sheets: json(sheetsConfigSchema),
    drive: json(driveConfigSchema),
    slack: json(slackConfigSchema),
    outlook: json(outlookConfigSchema),
    teams: json(teamsConfigSchema),
    telegram: json(telegramConfigSchema),
    sms: json(smsConfigSchema),
    calendar: json(calendarConfigSchema),
    airtable: json(airtableConfigSchema),
    notion: json(notionConfigSchema),
    trello: json(trelloConfigSchema),
    booking: json(bookingConfigSchema),
    paymongo_link: json(paymongoLinkConfigSchema),
    payment_status: json(paymentStatusConfigSchema),
    payment_due: json(paymentDueConfigSchema),
    payment_expire: json(paymentExpireConfigSchema),
    meta_reply: json(metaReplyConfigSchema),
    conversation_update: json(conversationUpdateConfigSchema),
    stay_quote: json(stayQuoteConfigSchema),
    assistant_read: json(assistantReadConfigSchema),
    discord: json(discordConfigSchema),
    google_docs: json(googleDocsConfigSchema),
    read_page: json(readPageConfigSchema),
    shopify_create_product: json(shopifyCreateProductConfigSchema),
    shopify_update_product: json(shopifyUpdateProductConfigSchema),
    browser: json(browserConfigSchema),
    call_workflow: json(callWorkflowConfigSchema),
  };
}
