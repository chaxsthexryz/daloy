import { managementTranslations } from "./locale-management";
import { brandTranslations } from "./locale-brand";
import { controlsTranslations } from "./locale-controls";
import { builderTranslations } from "./locale-builder";
import { guidedTranslations } from "./locale-guided";
import { viewTranslations } from "./locale-views";
import { googleTranslations } from "./locale-google";
import { recordTriggerTranslations } from "./locale-records";
import { gmailTranslations } from "./locale-gmail";
import { mailboxTranslations } from "./locale-mailbox";
import { calendarTranslations } from "./locale-calendar";
import { opsTranslations } from "./locale-ops";
import { setupTranslations } from "./locale-setup";
import { pasteTranslations } from "./locale-paste";
import { shopifyTranslations } from "./locale-shopify";
import { telegramTranslations } from "./locale-telegram";
import { browserTranslations } from "./locale-browser";
import { editorTranslations } from "./locale-editor";
import { activityTranslations } from "./locale-activity";
import { workspaceTranslations } from "./locale-workspace";
import { advancedTranslations } from "./locale-advanced";
import { entryTranslations } from "./locale-entry";
import { onboardingTranslations } from "./locale-onboarding";
import { dailyTranslations } from "./locale-daily";
import { privacyTranslations } from "./locale-privacy";
import { receiptsTranslations } from "./locale-receipts";
import { integrationTranslations } from "./locale-integrations";
import { readPageTranslations } from "./locale-read-page";
import { knowledgeTranslations } from "./locale-knowledge";
import { monitorChatTranslations } from "./locale-monitor-chat";
import { adminTranslations } from "./locale-admin";
import { whatsappTranslations } from "./locale-whatsapp";
import { liveTranslations } from "./locale-live";
import { chatTestTranslations } from "./locale-chat-test";
export type Language = "en" | "tl";

const tagalog: Record<string, string> = {
  // First, so a string another file already translates keeps its wording.
  ...knowledgeTranslations,
  ...shopifyTranslations,
  ...telegramTranslations,
  ...browserTranslations,
  ...managementTranslations,
  ...builderTranslations,
  ...guidedTranslations,
  ...viewTranslations,
  ...pasteTranslations,
  ...brandTranslations,
  ...controlsTranslations,
  ...googleTranslations,
  ...recordTriggerTranslations,
  ...gmailTranslations,
  ...mailboxTranslations,
  ...calendarTranslations,
  ...opsTranslations,
  ...setupTranslations,
  ...editorTranslations,
  ...activityTranslations,
  ...workspaceTranslations,
  ...advancedTranslations,
  ...entryTranslations,
  ...onboardingTranslations,
  ...dailyTranslations,
  ...privacyTranslations,
  ...receiptsTranslations,
  ...integrationTranslations,
  ...readPageTranslations,
  ...monitorChatTranslations,
  ...adminTranslations,
  ...whatsappTranslations,
  ...liveTranslations,
  ...chatTestTranslations,
  "Plan: {plan}": "Plan: {plan}",
  "{used}, no limit": "{used}, walang limit",
  "{used} of {limit}": "{used} sa {limit}",
  "AI actions: {count} this month": "AI actions: {count} ngayong buwan",
  "SMS messages: {count} this month": "Mga SMS: {count} ngayong buwan",
  "SMS messages": "mga SMS",
  "Steps that send SMS stop": "Hihinto ang mga hakbang na nagpapadala ng SMS",
  "Emails: {count} today": "Mga email: {count} ngayong araw",
  "Web requests: {count} today": "Web requests: {count} ngayong araw",
  "(back on {day})": "(babalik sa {day})",
  "Live automations: {count}": "Mga naka-on na automation: {count}",
  "Shortest schedule: every {minutes} minutes": "Pinakamaikling iskedyul: bawat {minutes} minuto",
  "To change your plan, message the kymavo operator. Payment is monthly by GCash or Maya.": "Para baguhin ang plan mo, mag-message sa kymavo operator. Buwanang bayad sa GCash o Maya.",
  "your business details and the website inquiry form": "detalye ng negosyo mo at website inquiry form",
  "who can use kymavo and what each person may do": "sino ang puwedeng gumamit ng kymavo at ano ang puwede nilang gawin",
  "rooms, people and tables that bookings reserve": "mga kuwarto, tao at mesa na nirereserba ng bookings",
  "which model drafts and classifies, and its key": "model na gumagawa ng draft at nag-uuri, at ang key nito",
  "for MCP clients and scripts": "para sa MCP clients at scripts",

  "Settings": "Mga setting", "New": "Bago", "New automation": "Bagong automation", "Automations": "Mga automation",
  "Activity": "Aktibidad", "Build with AI": "Bumuo gamit ang AI", "Bookings": "Mga booking", "Download CSV": "I-download ang CSV", "Team": "Koponan",
  "Apps": "Mga app", "Business": "Negosyo", "Advanced": "Advanced", "Sign out": "Mag-sign out", "Menu": "Menu",
  "Main": "Pangunahing menu", "Quick": "Mabilis na menu", "This automation": "Automation na ito", "Overview": "Buod", "Steps": "Mga hakbang",
  "Appearance": "Itsura", "System (follows this device)": "System (ayon sa device na ito)", "Light": "Light", "Dark": "Dark",
  "Saved on this device only.": "Sa device na ito lang naka-save.", "Your account": "Ang account mo", "Your office": "Ang opisina mo",
  "Owner": "Owner", "Operator": "Operator", "Approver": "Approver", "Requester": "Requester",
  "Signed in as {email}, {role}.": "Naka-sign in bilang {email}, {role}.", "Language": "Wika",
  "Language applies to this workspace.": "Ang wika ay para sa workspace na ito.", "Could not save language. Try again.": "Hindi na-save ang wika. Subukan ulit.",
  "Plan and usage": "Plan at paggamit", "No plan limits are set. The operator sets the plan.": "Walang limit na nakatakda. Ang operator ang nagtatakda ng plan.",
  "Loading…": "Naglo-load…", "Retry": "Subukan ulit", "Cancel": "Kanselahin", "Save": "I-save", "Back": "Bumalik", "Next": "Susunod", "Close": "Isara", "Delete": "Burahin", "Edit": "Baguhin", "Done": "Tapos na", "Continue": "Magpatuloy", "Connect": "Ikonekta", "Disconnect": "Idiskonekta", "Connected": "Nakakonekta", "More": "Iba pa", "All": "Lahat", "Name": "Pangalan", "Email": "Email", "Status": "Status", "Actions": "Mga aksyon", "Reference": "Reference", "Resource": "Resource", "Time": "Oras", "Move": "Ilipat", "No bookings yet. They appear when an automation's booking step books a resource.": "Wala pang booking. Lalabas dito kapag may nareserbang resource ang automation.", "Manage rooms and resources": "Pamahalaan ang mga kuwarto at resource",
  "Find an app": "Maghanap ng app", "Choose an automation": "Pumili ng automation", "Receive website form emails": "Tumanggap ng email mula sa website form", "Your business": "Ang negosyo mo", "Business name": "Pangalan ng negosyo", "Website": "Website", "Inbox for new inquiries": "Inbox para sa mga bagong inquiry", "Reply address (optional)": "Reply address (opsyonal)",
  "Resources": "Mga resource", "AI model": "AI model", "API tokens": "API tokens",
  "Page not found": "Hindi makita ang page",
  "AI model settings are managed by the kymavo operator for this workspace.": "Ang mga setting ng AI model ay pinamamahalaan ng kymavo operator para sa workspace na ito.",
  "This page does not exist, or your account cannot open it.": "Hindi umiiral ang page na ito, o walang access dito ang account mo.",
  "Back to Automations": "Bumalik sa Mga automation",
};

/** True when the Tagalog dictionary has an entry for `source`, even one that keeps the English word. */
export function hasTagalog(source: string): boolean {
  return Object.hasOwn(tagalog, source);
}

export function translate(language: Language, source: string, values: Record<string, string | number> = {}): string {
  const template = language === "tl" ? (tagalog[source] ?? source) : source;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}
