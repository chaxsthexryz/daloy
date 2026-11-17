import type { Language } from "./language";
import type { WorkflowDefinition } from "./definition";
import { TEMPLATES } from "./templates";

const LABELS: Record<string, string> = {
  "Your name": "Pangalan mo", "Your email": "Email mo", "Email": "Email", "How can we help?": "Paano kami makakatulong?",
  "What needs attention?": "Ano ang kailangang asikasuhin?", "Where is it?": "Saan ito?", "Anything else we should know?": "May iba pa ba kaming dapat malaman?",
  "What do you want to buy?": "Ano ang gusto mong bilhin?", "Estimated cost": "Tinatayang halaga", "Why is it needed?": "Bakit ito kailangan?",
};
type Message = { subject?: string; text?: string; message?: string };

/** Used only when generating a fresh template, never when reading or running saved definitions. */
export function localizeGeneratedDefinition(definition: WorkflowDefinition, language: Language, kind: string, values: { businessName?: string; approver?: string; extraFields?: string[] } = {}): WorkflowDefinition {
  if (language === "en") return definition;
  const result = structuredClone(definition);
  const a = values.approver ?? "";
  const more = (values.extraFields ?? []).map((f) => f === "location" ? "Saan: {{trigger.location}}" : "Detalye: {{trigger.details}}").join("\n");
  const requester = (subject: string, text: string): Message => ({ subject, text: `Hi {{trigger.name}},\n\n${text}\n\nReference: {{trigger.reference}}` });
  const messages: Record<string, Record<string, Message>> = {
    "office-request": {
      notify_office: { subject: "Bagong request {{trigger.reference}}: {{trigger.summary}}", text: `Nagpadala ng request si {{trigger.name}} ({{trigger.email}}).\n\n{{trigger.summary}}${more ? `\n${more}` : ""}\n\nReference: {{trigger.reference}}` },
      send_receipt: { subject: "Natanggap namin ang request mo {{trigger.reference}}", text: "Hi {{trigger.name}},\n\nNatanggap namin ang request mo: {{trigger.summary}}\nAng reference mo ay {{trigger.reference}}. Banggitin ito kapag nagtatanong tungkol sa request." },
      post_to_slack: { text: "Bagong office request {{trigger.reference}}: {{trigger.summary}}\nNasa Requests sa Daloy ang mga detalye." },
    },
    "purchase-request": {
      send_receipt: requester("Natanggap namin ang purchase request mo {{trigger.reference}}", `Natanggap namin ang request mo para sa {{trigger.summary}} ({{trigger.cost}}). Si ${a} ang magdedesisyon. Ipapadala sa email ang resulta.`),
      decide: { subject: "Purchase request {{trigger.reference}}: {{trigger.summary}}", message: "Gustong bilhin ni {{trigger.name}} ({{trigger.email}}):\n{{trigger.summary}}\nTinatayang halaga: {{trigger.cost}}\nDahilan: {{trigger.reason}}\n\nReference: {{trigger.reference}}" },
      tell_purchasing: { subject: "Na-approve na purchase {{trigger.reference}}: {{trigger.summary}}", text: `Inaprubahan ni ${a} ang purchase request na ito.\n\nItem: {{trigger.summary}}\nTinatayang halaga: {{trigger.cost}}\nHumiling: {{trigger.name}} ({{trigger.email}})\nDahilan: {{trigger.reason}}\n\nReference: {{trigger.reference}}` },
      tell_approved: requester("Na-approve ang purchase request mo {{trigger.reference}}", `Inaprubahan ni ${a} ang request mo para sa {{trigger.summary}}. Nasa purchasing na ito.`),
      tell_rejected: requester("Hindi na-approve ang purchase request mo {{trigger.reference}}", `Hindi inaprubahan ni ${a} ang request mo para sa {{trigger.summary}}. Magtanong sa kanya kung gusto mong malaman ang dahilan.`),
      tell_no_decision: requester("Walang desisyon sa purchase request mo {{trigger.reference}}", "Walang nagdesisyon sa request mo para sa {{trigger.summary}} sa loob ng isang linggo. Ipadala ulit kung kailangan mo pa ito."),
      post_to_teams: { text: "Na-approve ang purchase request {{trigger.reference}}: {{trigger.summary}}\nNasa purchasing ang mga detalye. Ang nakatalagang approver lang ang magdedesisyon sa Daloy." },
    },
    "website-inquiry": {
      reply_to_customer: { subject: `Salamat sa pag-contact sa ${values.businessName}`, text: `Hi {{trigger.name}},\n\nSalamat sa pagsulat sa ${values.businessName}. Natanggap namin ang mensahe mo at sasagot kami sa loob ng isang araw ng trabaho.\n\nMensahe mo:\n{{trigger.message}}` },
      notify_business: { subject: "Bagong website inquiry mula kay {{trigger.name}}", text: "Sumulat si {{trigger.name}} ({{trigger.email}}) gamit ang website form:\n\n{{trigger.message}}\n\nSumagot sa: {{trigger.email}}" },
    },
    "inquiry-triage": {
      acknowledge: { subject: "Natanggap namin ang mensahe mo", text: "Hi {{trigger.name}}, salamat sa pagsulat. Sasagot kami sa loob ng isang araw ng trabaho." },
      to_billing: { subject: "Tanong sa billing mula kay {{trigger.name}}", text: "{{trigger.message}}\n\nSumagot sa: {{trigger.email}}" },
      to_support: { subject: "Inquiry mula kay {{trigger.name}}", text: "{{trigger.message}}\n\nSumagot sa: {{trigger.email}}" },
    },
    "invoice-follow-up": { remind: { subject: "Paalala: invoice {{trigger.invoice_id}}", text: "Hi {{trigger.customer_name}}, hindi pa bayad ang invoice {{trigger.invoice_id}} na nagkakahalaga ng {{trigger.amount}}. Puwedeng magbayad dito: {{trigger.pay_url}}." } },
    "no-show-follow-up": { offer_rebook: { subject: "Hindi tayo nagkita sa booking mo", text: "Hi {{trigger.customer_name}}, hindi ka nakarating sa booking mo para sa {{trigger.service}}. Pumili ng bagong oras dito: {{trigger.rebook_url}}" } },
  };
  if (result.trigger.type === "form") {
    result.trigger.config.fields = result.trigger.config.fields.map((f) => ({ ...f, label: LABELS[f.label] ?? f.label }));
  }
  for (const step of result.steps) {
    const copy = messages[kind]?.[step.id];
    if (copy) Object.assign(step.config, copy);
  }
  return result;
}

export function templatesForLanguage(language: Language = "en") {
  return TEMPLATES.map((template) => ({ ...template, definition: localizeGeneratedDefinition(structuredClone(template.definition) as unknown as WorkflowDefinition, language, template.slug) }));
}
