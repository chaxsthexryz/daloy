import type { Language } from "./language";
import type { Step, Trigger } from "./definition";

/**
 * One catalog entry per trigger and per step type (roadmap R2a). The picker, the canvas node, the phone list, the
 * plain-language summary and the test results read their labels from here, so a name is written once, in both languages.
 * catalog.test.ts fails when a type in the definition schema has no entry.
 */
export type Text = { en: string; tl: string };
const tx = (en: string, tl: string): Text => ({ en, tl });

export type CatalogEntry = {
  /** The app's name, or null for an action Daloy does itself (a branch, a wait, an approval). */
  app: Text | null;
  /** A logo key (a file in apps/web/public/logos) or a Daloy line icon key. The web app maps it to a picture. */
  mark: string;
  /** The connection provider name GET /settings/connections uses, when the step needs a connected app. */
  provider?: string;
  action: Text;
  description: Text;
  /** Config fields the step cannot save without. */
  required: string[];
  input: Text;
  output: Text;
  outcomes: Text[];
};

const GMAIL = tx("Gmail", "Gmail");
const SHEETS = tx("Google Sheets", "Google Sheets");
const DRIVE = tx("Google Drive", "Google Drive");
const CALENDAR = tx("Google Calendar", "Google Calendar");
const PAYMONGO = tx("PayMongo", "PayMongo");
const META = tx("Messenger and Instagram", "Messenger at Instagram");
const queued = [tx("Queued for delivery", "Nakapila para ipadala"), tx("Failed, with the reason", "Nabigo, may dahilan")];

export const STEP_CATALOG: Record<Step["type"], CatalogEntry> = {
  condition: { app: null, mark: "branch", action: tx("Condition", "Kondisyon"), description: tx("Compare two values and follow the matching route.", "Ihambing ang dalawang value at sundan ang tamang daan."), required: ["condition"], input: tx("Two values, such as a form field and a number.", "Dalawang value, gaya ng field ng form at isang numero."), output: tx("The route taken.", "Ang daang tinahak."), outcomes: [tx("True", "Tama"), tx("False", "Mali")] },
  http: { app: null, mark: "globe", action: tx("HTTP request", "HTTP request sa web"), description: tx("Call a web address and keep its answer for the next steps.", "Tumawag sa web address at itago ang sagot para sa susunod na steps."), required: ["method", "url"], input: tx("A method and a web address, with optional headers and body.", "Isang method at web address, may headers at body kung kailangan."), output: tx("The response status and body.", "Ang status at body ng sagot."), outcomes: [tx("Answered", "Sumagot"), tx("Failed, retried when it is safe", "Nabigo, uulitin kapag ligtas")] },
  email: { app: GMAIL, mark: "gmail", provider: "gmail", action: tx("Send email", "Magpadala ng email"), description: tx("Send the message from the workspace's connected address.", "Ipadala ang mensahe mula sa naka-connect na address ng workspace."), required: ["to", "subject", "text"], input: tx("Recipient, subject and message.", "Tatanggap, subject at mensahe."), output: tx("Whether the email was sent.", "Kung naipadala ang email."), outcomes: [tx("Sent", "Naipadala"), tx("Failed, with the reason", "Nabigo, may dahilan")] },
  delay: { app: null, mark: "clock", action: tx("Delay", "Paghihintay"), description: tx("Wait a fixed time, or until a time from the request.", "Maghintay ng takdang oras, o hanggang sa oras mula sa request."), required: [], input: tx("Seconds, or a date and time with an offset.", "Segundo, o petsa at oras na may offset."), output: tx("Nothing. The run carries on later.", "Wala. Magpapatuloy ang run mamaya."), outcomes: [tx("Done waiting", "Tapos na ang paghihintay"), tx("Late, if the time already passed", "Huli na, kung lumipas na ang oras")] },
  ai: { app: null, mark: "ai", action: tx("AI task", "Gawain ng AI"), description: tx("Extract fields, classify or summarise text. The checks of Daloy decide what happens next.", "Kumuha ng fields, mag-uri o mag-buod ng text. Ang mga check ng Daloy ang magpapasya sa susunod."), required: ["task"], input: tx("Text from the request, and the fields or labels to look for.", "Text mula sa request, at ang fields o labels na hahanapin."), output: tx("The fields or the label the AI found.", "Ang fields o label na nakita ng AI."), outcomes: [tx("Answered", "Sumagot"), tx("Failed, with the reason", "Nabigo, may dahilan")] },
  approval: { app: null, mark: "person-check", action: tx("Approval", "Pag-apruba"), description: tx("Ask a named person to approve or reject, then follow their answer.", "Hilingin sa isang pinangalanang tao na aprubahan o tanggihan, saka sundan ang sagot."), required: ["subject", "message", "timeoutSeconds"], input: tx("Who decides, the message and how long to wait.", "Sino ang magpapasya, ang mensahe at gaano katagal maghihintay."), output: tx("The decision.", "Ang desisyon."), outcomes: [tx("Approved", "Inaprubahan"), tx("Rejected", "Tinanggihan"), tx("Timed out", "Lumipas ang oras")] },
  sheets: { app: SHEETS, mark: "google-sheets", provider: "google_sheets", action: tx("Add a row", "Magdagdag ng row"), description: tx("Add one row to the sheet chosen in Apps for every request.", "Magdagdag ng isang row sa sheet na pinili sa Apps para sa bawat request."), required: ["columns"], input: tx("One value for each column.", "Isang value para sa bawat column."), output: tx("Whether the row was added.", "Kung naidagdag ang row."), outcomes: queued },
  drive: { app: DRIVE, mark: "google-drive", provider: "google_drive", action: tx("Save files", "I-save ang mga file"), description: tx("Save the files people attached to a form in the Drive folder chosen in Apps.", "I-save ang mga file na inilagay sa form sa Drive folder na pinili sa Apps."), required: [], input: tx("The form's file fields.", "Ang mga file field ng form."), output: tx("Whether the files were saved.", "Kung na-save ang mga file."), outcomes: queued },
  slack: { app: tx("Slack", "Slack"), mark: "slack", provider: "slack", action: tx("Post a message", "Mag-post ng mensahe"), description: tx("Post a short note to the Slack channel chosen in Apps. Everyone in the channel can read it.", "Mag-post ng maikling note sa Slack channel na pinili sa Apps. Mababasa ito ng lahat sa channel."), required: ["text"], input: tx("The message text.", "Ang text ng mensahe."), output: tx("Whether the message was posted.", "Kung na-post ang mensahe."), outcomes: queued },
  outlook: { app: tx("Outlook", "Outlook"), mark: "outlook", provider: "outlook", action: tx("Send email", "Magpadala ng email"), description: tx("Send the message from the Outlook mailbox the owner connected.", "Ipadala ang mensahe mula sa Outlook mailbox na ikinonekta ng owner."), required: ["to", "subject", "text"], input: tx("Recipient, subject and message.", "Tatanggap, subject at mensahe."), output: tx("Whether the email was sent.", "Kung naipadala ang email."), outcomes: queued },
  teams: { app: tx("Microsoft Teams", "Microsoft Teams"), mark: "teams", provider: "teams", action: tx("Post a message", "Mag-post ng mensahe"), description: tx("Post a note to the Teams channel chosen in Apps. It is a notification only.", "Mag-post ng note sa Teams channel na pinili sa Apps. Abiso lang ito."), required: ["text"], input: tx("The message text.", "Ang text ng mensahe."), output: tx("Whether the message was posted.", "Kung na-post ang mensahe."), outcomes: queued },
  telegram: { app: tx("Telegram", "Telegram"), mark: "telegram", provider: "telegram", action: tx("Send a message", "Magpadala ng mensahe"), description: tx("Send plain text to the Telegram chat chosen in Apps.", "Magpadala ng plain text sa Telegram chat na pinili sa Apps."), required: ["text"], input: tx("The message text.", "Ang text ng mensahe."), output: tx("Whether the message was sent.", "Kung naipadala ang mensahe."), outcomes: queued },
  sms: { app: tx("UniSMS", "UniSMS"), mark: "unisms", provider: "unisms", action: tx("Send an SMS", "Magpadala ng SMS"), description: tx("Send a confirmation or reminder to a Philippine mobile number. Each message has a cost.", "Magpadala ng kumpirmasyon o paalala sa mobile number sa Pilipinas. May bayad ang bawat mensahe."), required: ["to", "message"], input: tx("A Philippine mobile number and the message, up to 670 characters.", "Mobile number sa Pilipinas at ang mensahe, hanggang 670 character."), output: tx("Whether the SMS was accepted.", "Kung tinanggap ang SMS."), outcomes: [...queued, tx("Needs review, if the outcome is unknown", "Kailangang suriin, kung hindi alam ang resulta")] },
  calendar: { app: CALENDAR, mark: "google-calendar", provider: "google_calendar", action: tx("Add an event", "Magdagdag ng event"), description: tx("Put the booking on the calendar chosen in Apps. It moves or goes away with the booking.", "Ilagay ang booking sa calendar na pinili sa Apps. Lilipat o mawawala ito kasama ng booking."), required: ["title"], input: tx("An event title and optional notes.", "Pamagat ng event at mga note kung gusto."), output: tx("Whether the event was saved.", "Kung na-save ang event."), outcomes: queued },
  airtable: { app: tx("Airtable", "Airtable"), mark: "airtable", provider: "airtable", action: tx("Add a record", "Magdagdag ng record"), description: tx("Add one record to the Airtable table chosen in Apps.", "Magdagdag ng isang record sa Airtable table na pinili sa Apps."), required: ["fields"], input: tx("A value for each field name.", "Isang value para sa bawat pangalan ng field."), output: tx("Whether the record was added.", "Kung naidagdag ang record."), outcomes: queued },
  notion: { app: tx("Notion", "Notion"), mark: "notion", provider: "notion", action: tx("Add a page", "Magdagdag ng page"), description: tx("Add one page to the Notion database chosen in Apps.", "Magdagdag ng isang page sa Notion database na pinili sa Apps."), required: ["title"], input: tx("A page title and optional text properties.", "Pamagat ng page at mga text property kung gusto."), output: tx("Whether the page was added.", "Kung naidagdag ang page."), outcomes: queued },
  trello: { app: tx("Trello", "Trello"), mark: "trello", provider: "trello", action: tx("Add a card", "Magdagdag ng card"), description: tx("Add one card to the Trello list chosen in Apps.", "Magdagdag ng isang card sa Trello list na pinili sa Apps."), required: ["name"], input: tx("A card name and optional description.", "Pangalan ng card at paglalarawan kung gusto."), output: tx("Whether the card was added.", "Kung naidagdag ang card."), outcomes: queued },
  booking: { app: null, mark: "calendar", action: tx("Booking", "Reserbasyon"), description: tx("Reserve, move or cancel a booking for a resource such as a therapist or a room.", "Mag-reserve, maglipat o magkansela ng booking para sa resource gaya ng therapist o kuwarto."), required: ["action"], input: tx("The action, the resource and time, or the booking reference.", "Ang aksyon, ang resource at oras, o ang reference ng booking."), output: tx("The booking reference and time.", "Ang reference at oras ng booking."), outcomes: [tx("Booked or changed", "Na-book o nabago"), tx("Time already taken", "Kinuha na ang oras"), tx("Booking not found", "Hindi nakita ang booking")] },
  payment_due: {
    app: null, mark: "form", action: tx("Ask for payment", "Humingi ng bayad"),
    description: tx("Create a payment request for an order or booking.", "Gumawa ng kahilingan sa bayad para sa order o booking."),
    required: ["amount", "reference"], input: tx("Order reference and amount in pesos.", "Reference ng order at halaga sa piso."),
    output: tx("Payment request and payment page link.", "Kahilingan sa bayad at link sa pahina ng pagbabayad."),
    outcomes: [tx("Payment requested", "Nahiling ang bayad"), tx("Failed, with the reason", "Nabigo, may dahilan")],
  },
  payment_expire: {
    app: null, mark: "clock", action: tx("Cancel if unpaid", "Kanselahin kung hindi bayad"),
    description: tx("Check the payment request at its deadline and release an expired booking.", "Suriin ang bayad sa takdang oras at palayain ang slot ng napasong booking."),
    required: ["due"], input: tx("An earlier payment request step.", "Naunang hakbang na humingi ng bayad."),
    output: tx("Whether the request expired or was kept.", "Kung napaso o nanatili ang kahilingan."),
    outcomes: [tx("Expired", "Napaso"), tx("Kept", "Nanatili")],
  },
  paymongo_link: { app: PAYMONGO, mark: "paymongo", provider: "paymongo", action: tx("Create a payment link", "Gumawa ng payment link"), description: tx("Create a checkout link for the amount in pesos. A later step sends it to the customer.", "Gumawa ng checkout link para sa halaga sa piso. Ipapadala ito ng susunod na step sa customer."), required: ["amount", "description", "reference"], input: tx("The amount in pesos, a description and the order reference.", "Ang halaga sa piso, paglalarawan at reference ng order."), output: tx("The checkout link.", "Ang checkout link."), outcomes: [tx("Link created", "Nagawa ang link"), tx("Failed, with the reason", "Nabigo, may dahilan")] },
  payment_status: { app: PAYMONGO, mark: "paymongo", provider: "paymongo", action: tx("Check a payment", "Tingnan ang bayad"), description: tx("Read the current status of a payment link made earlier in this run. It never calls PayMongo.", "Basahin ang kasalukuyang status ng payment link na ginawa kanina sa run na ito. Hindi ito tumatawag sa PayMongo."), required: ["link"], input: tx("The id of the payment link step.", "Ang id ng step ng payment link."), output: tx("Pending, paid, needs review or refunded.", "Pending, bayad na, kailangang suriin o na-refund."), outcomes: [tx("Pending", "Pending"), tx("Paid", "Bayad na"), tx("Needs review", "Kailangang suriin"), tx("Refunded", "Na-refund")] },
  meta_reply: { app: META, mark: "messenger", provider: "meta_messenger", action: tx("Reply to a message", "Sumagot sa mensahe"), description: tx("Reply to the customer in the same conversation, within Meta's 24-hour window.", "Sumagot sa customer sa parehong usapan, sa loob ng 24 oras na window ng Meta."), required: ["text"], input: tx("The reply text. The customer and channel come from the message.", "Ang text ng sagot. Ang customer at channel ay mula sa mensahe."), output: tx("Whether the reply was sent.", "Kung naipadala ang sagot."), outcomes: queued },
};

export const TRIGGER_CATALOG: Record<Trigger["type"], CatalogEntry> = {
  manual: { app: null, mark: "play", action: tx("You run it", "Ikaw ang magpapatakbo"), description: tx("Start the automation yourself with sample data.", "Simulan ang automation mismo gamit ang sample data."), required: [], input: tx("Whatever you type as sample data.", "Anumang i-type mo bilang sample data."), output: tx("The sample data.", "Ang sample data."), outcomes: [tx("Started", "Nagsimula")] },
  email: { app: null, mark: "mail", action: tx("An email arrives", "May dumating na email"), description: tx("Start when a message reaches the mailbox set up for this automation.", "Magsimula kapag may mensaheng dumating sa mailbox na itinakda para sa automation na ito."), required: [], input: tx("The email: sender, subject and text.", "Ang email: nagpadala, subject at text."), output: tx("The email as trigger fields.", "Ang email bilang trigger fields."), outcomes: [tx("Started", "Nagsimula")] },
  webhook: { app: null, mark: "link", action: tx("A system sends an event", "May system na nagpadala ng event"), description: tx("Start when another system calls the Daloy address with data.", "Magsimula kapag tumawag ang ibang system sa address ng Daloy na may data."), required: [], input: tx("The data the other system sends.", "Ang data na ipinapadala ng ibang system."), output: tx("The data as trigger fields.", "Ang data bilang trigger fields."), outcomes: [tx("Started", "Nagsimula"), tx("Refused, if the signature is wrong", "Tinanggihan, kung mali ang signature")] },
  schedule: { app: null, mark: "clock", action: tx("On a schedule", "Ayon sa iskedyul"), description: tx("Start at the times in the schedule, such as every Monday at 9.", "Magsimula sa mga oras ng iskedyul, gaya ng bawat Lunes ng alas-9."), required: [], input: tx("A schedule.", "Isang iskedyul."), output: tx("The time it started.", "Ang oras ng pagsisimula."), outcomes: [tx("Started", "Nagsimula")] },
  form: { app: null, mark: "form", action: tx("A form is submitted", "May nag-submit ng form"), description: tx("Start when someone sends the form. Each request gets a reference.", "Magsimula kapag may nagpadala ng form. May reference ang bawat request."), required: ["fields"], input: tx("The form's fields.", "Ang mga field ng form."), output: tx("The answers as trigger fields.", "Ang mga sagot bilang trigger fields."), outcomes: [tx("Started", "Nagsimula"), tx("Refused, if a field is invalid", "Tinanggihan, kung may maling field")] },
  payment: { app: PAYMONGO, mark: "paymongo", provider: "paymongo", action: tx("A payment is reported", "May naiulat na bayad"), description: tx("Start when PayMongo reports a payment that Daloy has checked.", "Magsimula kapag may iniulat na bayad ang PayMongo na na-check ng Daloy."), required: [], input: tx("A verified PayMongo event.", "Isang beripikadong PayMongo event."), output: tx("The payment as trigger fields.", "Ang bayad bilang trigger fields."), outcomes: [tx("Started", "Nagsimula")] },
  meta_dm: { app: META, mark: "messenger", provider: "meta_messenger", action: tx("A customer sends a message", "May customer na nagpadala ng mensahe"), description: tx("Start when a Messenger or Instagram DM arrives on the connected account.", "Magsimula kapag may DM sa Messenger o Instagram sa naka-connect na account."), required: [], input: tx("The message and any photos.", "Ang mensahe at mga larawan."), output: tx("The message as trigger fields.", "Ang mensahe bilang trigger fields."), outcomes: [tx("Started", "Nagsimula")] },
};

const pick = (t: Text, language: Language) => t[language];
export const stepEntry = (type: Step["type"]): CatalogEntry => STEP_CATALOG[type];
export const triggerEntry = (type: Trigger["type"]): CatalogEntry => TRIGGER_CATALOG[type];

/** "Gmail, Send email". A built-in action has no app, so its label is the action alone. */
export function entryLabel(e: CatalogEntry, language: Language): string {
  return e.app ? `${pick(e.app, language)}, ${pick(e.action, language)}` : pick(e.action, language);
}
export const stepLabel = (type: Step["type"], language: Language = "en") => entryLabel(STEP_CATALOG[type], language);
export const triggerLabel = (type: Trigger["type"], language: Language = "en") => entryLabel(TRIGGER_CATALOG[type], language);

export type DestinationContext = {
  language: Language;
  trigger?: Trigger;
  /** The name of the destination the owner picked in Apps (a channel, a sheet, a list), when the app is connected and has one. */
  chosen?: string;
};

const TRIGGER_NOUN: Record<Trigger["type"], Text> = {
  form: tx("the form", "form"),
  webhook: tx("the event", "event"),
  email: tx("the email", "email"),
  payment: tx("the payment", "bayad"),
  meta_dm: tx("the message", "mensahe"),
  schedule: tx("the schedule", "iskedyul"),
  manual: tx("the sample data", "sample data"),
};
const FROM = tx("{what} from {where}", "{what} mula sa {where}");
const STEP_FROM = tx("{what} from step {id}", "{what} mula sa step {id}");
const fill = (t: Text, language: Language, values: Record<string, string>) => pick(t, language).replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "");

const REF = /\{\{\s*([^}]+?)\s*\}\}/g;
/** A template as words: {{trigger.email}} becomes "Customer email from the form". A literal stays as typed. */
function human(value: string, { language, trigger }: DestinationContext): string {
  return value.replace(REF, (_, ref: string) => {
    const [root, ...path] = ref.split(".");
    if (root === "trigger" && path.length) {
      const name = path.join(".");
      const fields = trigger && (trigger.type === "form" || trigger.type === "webhook") ? trigger.config.fields ?? [] : [];
      const label = fields.find((f) => f.name === name)?.label ?? name;
      return fill(FROM, language, { what: label, where: trigger ? pick(TRIGGER_NOUN[trigger.type], language) : pick(tx("the trigger", "trigger"), language) });
    }
    if (root === "steps" && path.length >= 3 && path[1] === "output") return fill(STEP_FROM, language, { what: path.slice(2).join("."), id: path[0]! });
    if (root === "steps") return fill(STEP_FROM, language, { what: pick(tx("result", "resulta"), language), id: path[0] ?? "" });
    if (root === "secrets") return pick(tx("a saved secret", "isang naka-save na secret"), language);
    return ref;
  });
}

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const label = (en: string, tl: string): Text => tx(en, tl);
const TO = label("To", "Para kay");
const ASK_APPS = tx("chosen in Apps", "pipiliin sa Apps");

/** The line under a node's title: who or where the step acts on, as words. Always non-empty. */
export function destination(step: Step, ctx: DestinationContext): string {
  const { language } = ctx;
  const line = (prefix: Text, value: string) => `${pick(prefix, language)}: ${value}`;
  const picked = (prefix: Text) => line(prefix, ctx.chosen ?? pick(ASK_APPS, language));
  switch (step.type) {
    case "email":
    case "outlook":
    case "sms":
      return line(TO, short(human(String(step.config.to), ctx)));
    case "approval":
      return line(label("Ask", "Tanungin"), short(step.config.approver ?? human(String(step.config.to ?? ""), ctx)));
    case "sheets":
      return picked(label("Sheet", "Sheet"));
    case "drive":
      return picked(label("Folder", "Folder"));
    case "slack":
    case "teams":
      return picked(label("Channel", "Channel"));
    case "telegram":
      return picked(label("Chat", "Chat"));
    case "calendar":
      return picked(label("Calendar", "Calendar"));
    case "airtable":
      return picked(label("Table", "Table"));
    case "notion":
      return picked(label("Database", "Database"));
    case "trello":
      return picked(label("List", "List"));
    case "meta_reply":
      return step.config.recipientId.trim() === "{{trigger.senderId}}" ? line(TO, pick(tx("the customer in the conversation", "ang customer sa usapan"), language)) : line(TO, short(human(step.config.recipientId, ctx)));
    case "http": {
      let host = step.config.url;
      try { host = new URL(step.config.url).host || host; } catch { /* a template in the address: show it as typed */ }
      return line(label("Calls", "Tatawag sa"), `${step.config.method} ${short(host)}`);
    }
    case "condition":
      return line(label("If", "Kung"), short(`${human(step.config.condition.left, ctx)} ${step.config.condition.op} ${human(String(step.config.condition.right ?? ""), ctx)}`.trim()));
    case "delay":
      return step.config.until === undefined ? line(label("Wait", "Hintay"), `${step.config.seconds} s`) : line(label("Until", "Hanggang"), short(human(step.config.until, ctx)));
    case "ai":
      return line(label("Task", "Gawain"), step.config.task);
    case "booking":
      return step.config.action === "create" ? line(label("Resource", "Resource"), short(human(String(step.config.resource ?? ""), ctx))) : line(label("Booking", "Booking"), short(human(String(step.config.booking ?? ""), ctx)));
    case "payment_expire":
      return line(label("Payment request", "Kahilingan sa bayad"), step.config.due);
    case "payment_due":
    case "paymongo_link":
      return line(label("Amount", "Halaga"), `${human(String(step.config.amount), ctx)} ${pick(tx("pesos", "piso"), language)}`);
    case "payment_status":
      return line(label("Payment", "Bayad"), pick(tx("from step {id}", "mula sa step {id}"), language).replace("{id}", step.config.link));
  }
}

/** The label of a Daloy line icon or app when no picture is available, so every mark has text. */
export const markText = (e: CatalogEntry, language: Language): string => (e.app ? pick(e.app, language) : pick(e.action, language));
