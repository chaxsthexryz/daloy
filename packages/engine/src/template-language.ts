import type { Language } from "./language";
import type { WorkflowDefinition } from "./definition";
import { TEMPLATES } from "./templates";

const LABELS: Record<string, string> = {
  "Your name": "Pangalan mo", "Your email": "Email mo", "Email": "Email", "How can we help?": "Paano kami makakatulong?",
  "What needs attention?": "Ano ang kailangang asikasuhin?", "Where is it?": "Saan ito?", "Anything else we should know?": "May iba pa ba kaming dapat malaman?",
  "What do you want to buy?": "Ano ang gusto mong bilhin?", "Estimated cost": "Tinatayang halaga", "Why is it needed?": "Bakit ito kailangan?",
  "Service": "Serbisyo", "Appointment time": "Oras ng appointment", "Preferred time": "Gustong oras", "Who or what to book": "Sino o ano ang ibu-book", "What do you need?": "Ano ang kailangan mo?", "What do you want to order?": "Ano ang gusto mong i-order?", "Amount in pesos": "Halaga sa piso", "Deposit in pesos": "Deposito sa piso", "Invoice number": "Numero ng invoice", "Customer name": "Pangalan ng customer", "Customer email": "Email ng customer", "What renews? (domain, hosting, SSL, permit, insurance)": "Ano ang ire-renew? (domain, hosting, SSL, permit, insurance)", "Expires on": "Mag-e-expire sa", "Send the reminder to": "Pagpapadalhan ng paalala", "Order number": "Numero ng order", "Total in pesos": "Kabuuan sa piso", "Receipt photo": "Litrato ng resibo", "Note": "Tala",
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
      send_receipt: { subject: "Natanggap namin ang request mo {{trigger.reference}}", text: "Natanggap namin ang request mo.\nAng reference mo ay {{trigger.reference}}. Banggitin ito kapag nagtatanong tungkol sa request." },
      post_to_slack: { text: "Bagong office request {{trigger.reference}}: {{trigger.summary}}\nNasa Requests sa Daloy ang mga detalye." },
    },
    "purchase-request": {
      send_receipt: { subject: "Natanggap namin ang purchase request mo {{trigger.reference}}", text: `Natanggap namin ang purchase request mo. Si ${a} ang magdedesisyon. Ipapadala sa email ang resulta.\n\nReference: {{trigger.reference}}` },
      decide: { subject: "Purchase request {{trigger.reference}}: {{trigger.summary}}", message: "Gustong bilhin ni {{trigger.name}} ({{trigger.email}}):\n{{trigger.summary}}\nTinatayang halaga: {{trigger.cost}}\nDahilan: {{trigger.reason}}\n\nReference: {{trigger.reference}}" },
      tell_purchasing: { subject: "Na-approve na purchase {{trigger.reference}}: {{trigger.summary}}", text: `Inaprubahan ni ${a} ang purchase request na ito.\n\nItem: {{trigger.summary}}\nTinatayang halaga: {{trigger.cost}}\nHumiling: {{trigger.name}} ({{trigger.email}})\nDahilan: {{trigger.reason}}\n\nReference: {{trigger.reference}}` },
      tell_approved: requester("Na-approve ang purchase request mo {{trigger.reference}}", `Inaprubahan ni ${a} ang request mo para sa {{trigger.summary}}. Nasa purchasing na ito.`),
      tell_rejected: requester("Hindi na-approve ang purchase request mo {{trigger.reference}}", `Hindi inaprubahan ni ${a} ang request mo para sa {{trigger.summary}}. Magtanong sa kanya kung gusto mong malaman ang dahilan.`),
      tell_no_decision: { subject: "Walang desisyon sa purchase request mo {{trigger.reference}}", text: "Walang nagdesisyon sa purchase request mo sa loob ng isang linggo. Ipadala ulit kung kailangan mo pa ito.\n\nReference: {{trigger.reference}}" },
      post_to_teams: { text: "Na-approve ang purchase request {{trigger.reference}}: {{trigger.summary}}\nNasa purchasing ang mga detalye. Ang nakatalagang approver lang ang magdedesisyon sa Daloy." },
    },
    "website-inquiry": {
      reply_to_customer: { subject: `Salamat sa pag-contact sa ${values.businessName}`, text: `Salamat sa pagsulat sa ${values.businessName}. Natanggap namin ang mensahe mo at sasagot kami sa loob ng isang araw ng trabaho.` },
      notify_business: { subject: "Bagong website inquiry mula kay {{trigger.name}}", text: "Sumulat si {{trigger.name}} ({{trigger.email}}) gamit ang website form:\n\n{{trigger.message}}\n\nSumagot sa: {{trigger.email}}" },
    },
    "inquiry-triage": {
      acknowledge: { subject: "Natanggap namin ang mensahe mo", text: "Salamat sa pagsulat. Sasagot kami sa loob ng isang araw ng trabaho." },
      to_billing: { subject: "Tanong sa billing mula kay {{trigger.name}}", text: "{{trigger.message}}\n\nSumagot sa: {{trigger.email}}" },
      to_support: { subject: "Inquiry mula kay {{trigger.name}}", text: "{{trigger.message}}\n\nSumagot sa: {{trigger.email}}" },
    },
    "invoice-follow-up": { remind: { subject: "Paalala: invoice {{trigger.invoice_id}}", text: "Hi {{trigger.customer_name}}, hindi pa bayad ang invoice {{trigger.invoice_id}} na nagkakahalaga ng {{trigger.amount}}. Puwedeng magbayad dito: {{trigger.pay_url}}." } },
    "no-show-follow-up": { offer_rebook: { subject: "Hindi tayo nagkita sa booking mo", text: "Hi {{trigger.customer_name}}, hindi ka nakarating sa booking mo para sa {{trigger.service}}. Pumili ng bagong oras dito: {{trigger.rebook_url}}" } },
    "appointment-reminder": { remind: { subject: "Paalala: ang {{trigger.service}} appointment mo", text: "Hi {{trigger.name}}, paalala ito sa {{trigger.service}} appointment mo sa {{trigger.appointment_at}}. Sumagot sa email na ito kung kailangan mong baguhin." } },
    "request-to-sheets": { send_receipt: { subject: "Natanggap namin ang request mo", text: "Salamat, idinagdag na namin ang request mo sa listahan namin at babalikan ka namin agad." } },
    "lead-to-booking": {
      decide: { subject: "Booking request mula kay {{trigger.name}}", message: "Humihiling si {{trigger.name}} ({{trigger.email}}) ng {{trigger.service}} sa {{trigger.appointment_at}}." },
      tell_declined: { subject: "Tungkol sa booking request mo", text: "Hi {{trigger.name}}, salamat sa pagtanong. Hindi pa namin matatanggap ang booking na iyon sa ngayon." },
      tell_no_decision: { subject: "Naghihintay ang booking request ni {{trigger.name}}", text: "Walang sumagot sa booking request ni {{trigger.name}} ({{trigger.email}}) sa loob ng dalawang araw. Pakisagot siya." },
      confirm: { subject: "Kumpirmado na ang {{trigger.service}} booking mo", text: "Hi {{trigger.name}}, naka-book ka na sa {{trigger.appointment_at}}. Kita tayo." },
      tell_taken: { subject: "Hindi na available ang oras na iyon", text: "Hi {{trigger.name}}, may nag-book na sa {{trigger.appointment_at}}. Ipadala ulit ang form na may ibang oras." },
      tell_owner: { subject: "May problema sa booking ni {{trigger.name}}", text: "Humiling si {{trigger.name}} ({{trigger.email}}) ng resource na hindi makita. Pakisagot siya." },
    },
    "order-to-sheets": {
      approve_price: { subject: "Order mula kay {{trigger.name}}: {{trigger.item}}", message: "Gustong umorder ni {{trigger.name}} ({{trigger.email}}) ng:\n{{trigger.item}}\nHalagang inilagay ng buyer: {{trigger.amount}} piso\nI-approve lang kung ito ang presyo mo para sa item." },
      send_link: { subject: "Bayaran ang order mo: {{trigger.item}}", text: "Hi {{trigger.name}}, salamat sa order mo na {{trigger.item}} ({{trigger.amount}} piso). Magbayad dito: {{steps.pay_link.output.url}}" },
      tell_declined: { subject: "Tungkol sa order mo: {{trigger.item}}", text: "Hi {{trigger.name}}, salamat sa order mo. Hindi namin ito matatanggap sa presyong iyon. Makipag-ugnayan sa amin para maayos ito." },
      tell_no_decision: { subject: "Naghihintay ang order ni {{trigger.name}}", text: "Walang sumagot sa order ni {{trigger.name}} ({{trigger.email}}) para sa {{trigger.item}} sa loob ng dalawang araw. Pakisagot siya." },
    },
    "invoice-paymongo": {
      send_invoice: { subject: "Invoice {{trigger.invoice_id}}", text: "Hi {{trigger.customer_name}}, handa na ang invoice {{trigger.invoice_id}} na {{trigger.amount}} piso. Magbayad dito: {{steps.pay_link.output.url}}" },
      remind: { subject: "Paalala: invoice {{trigger.invoice_id}}", text: "Hi {{trigger.customer_name}}, bukas pa ang invoice {{trigger.invoice_id}} na {{trigger.amount}} piso. Magbayad dito: {{steps.pay_link.output.url}}" },
      tell_owner: { subject: "Dalawang linggo nang lampas ang invoice {{trigger.invoice_id}}", text: "Hindi pa nagbabayad si {{trigger.customer_name}} ({{trigger.customer_email}}) sa invoice {{trigger.invoice_id}} ({{trigger.amount}} piso) matapos ang dalawang paalala." },
    },
    "renewal-reminders": { remind: { subject: "Due na sa 30 araw ang renewal: {{trigger.item}}", text: "Mag-e-expire ang {{trigger.item}} sa {{trigger.expires_at}}. I-renew na ito para hindi ma-lapse." } },
    "store-orders": {
      send_receipt: { subject: "Natanggap namin ang order mo {{trigger.order_id}}", text: "Hi {{trigger.customer_name}}, salamat sa order mo {{trigger.order_id}} ({{trigger.total}} piso). Mag-e-email kami kapag naipadala na ito." },
      tell_owner: { text: "Bagong order {{trigger.order_id}}: {{trigger.total}} piso. Nasa sheet mo ang mga detalye." },
    },
    "receipt-expense": {
      approve: { subject: "Gastos mula kay {{trigger.name}}", message: "Nagpadala ng resibo si {{trigger.name}}.\nTindahan: {{steps.read_receipt.output.shop}}\nHalaga: {{steps.read_receipt.output.amount}}\nNasa run page sa Daloy ang litrato." },
      tell_approved: { subject: "Na-approve ang gastos mo", text: "Hi {{trigger.name}}, na-approve ang resibo mo mula sa {{steps.read_receipt.output.shop}} ({{steps.read_receipt.output.amount}}) at naidagdag na sa listahan ng gastos." },
      tell_rejected: { subject: "Hindi na-approve ang gastos mo", text: "Hi {{trigger.name}}, hindi na-approve ang resibo mo mula sa {{steps.read_receipt.output.shop}} ({{steps.read_receipt.output.amount}})." },
      tell_no_decision: { subject: "Wala pang desisyon sa gastos mo", text: "Wala pang nagdesisyon sa ipinadala mong gastos. Magtanong sa may-ari." },
    },
    "quote-deposit": {
      decide: { subject: "Quote request mula kay {{trigger.name}}", message: "Humihingi si {{trigger.name}} ({{trigger.email}}) ng:\n{{trigger.service}}\nDeposito: {{trigger.deposit}} piso" },
      send_deposit: { subject: "Na-approve ang quote mo", text: "Hi {{trigger.name}}, kaya naming gawin. Pakibayaran ang {{trigger.deposit}} pisong deposito para makumpirma: {{steps.deposit_link.output.url}}" },
      tell_declined: { subject: "Tungkol sa quote request mo", text: "Hi {{trigger.name}}, salamat sa pagtanong. Hindi pa namin ito matatanggap sa ngayon." },
      tell_no_decision: { subject: "Naghihintay ang quote request ni {{trigger.name}}", text: "Walang sumagot sa quote request ni {{trigger.name}} ({{trigger.email}}) sa loob ng dalawang araw. Pakisagot siya." },
    },
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
