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
  /** The app's name, or null for an action kymavo does itself (a branch, a wait, an approval). */
  app: Text | null;
  /** A logo key (a file in apps/web/public/logos) or a kymavo line icon key. The web app maps it to a picture. */
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
const OUTLOOK = tx("Outlook", "Outlook");
const SHEETS = tx("Google Sheets", "Google Sheets");
const DRIVE = tx("Google Drive", "Google Drive");
const CALENDAR = tx("Google Calendar", "Google Calendar");
const DOCS = tx("Google Docs", "Google Docs");
const PAYMONGO = tx("PayMongo", "PayMongo");
const SHOPIFY = tx("Shopify", "Shopify");
const AIRTABLE = tx("Airtable", "Airtable");
const NOTION = tx("Notion", "Notion");
const TRELLO = tx("Trello", "Trello");
const META = tx("Messenger and Instagram", "Messenger at Instagram");
const TELEGRAM = tx("Telegram", "Telegram");
const queued = [tx("Queued for delivery", "Nakapila para ipadala"), tx("Failed, with the reason", "Nabigo, may dahilan")];

export const STEP_CATALOG: Record<Step["type"], CatalogEntry> = {
  condition: { app: null, mark: "branch", action: tx("Condition", "Kondisyon"), description: tx("Compare two values and follow the matching route.", "Ihambing ang dalawang value at sundan ang tamang daan."), required: ["condition"], input: tx("Two values, such as a form field and a number.", "Dalawang value, gaya ng field ng form at isang numero."), output: tx("The route taken.", "Ang daang tinahak."), outcomes: [tx("True", "Tama"), tx("False", "Mali")] },
  switch: { app: null, mark: "branch", action: tx("Switch", "Pumili ng daan"), description: tx("Match a value against up to 10 cases and follow the matching route, or default.", "Itugma ang isang value sa hanggang 10 kaso at sundan ang katugmang daan, o default."), required: ["value", "cases"], input: tx("A value to match and up to 10 case values.", "Isang value na itutugma at hanggang 10 kaso."), output: tx("The matched case label and value.", "Ang katugmang label ng kaso at value."), outcomes: [tx("Matched case", "Tumugmang kaso"), tx("Default branch", "Default na daan")] },
  transform: { app: null, mark: "form", action: tx("Transform", "I-format ang data"), description: tx("Format dates in a timezone, Philippine pesos, PH mobile numbers, text case or pick an object.", "I-format ang petsa ayon sa timezone, piso sa Pilipinas, mobile number sa PH, teksto o pumili ng object."), required: ["op"], input: tx("An operation and a value or template fields.", "Isang operasyon at value o mga template field."), output: tx("The formatted value or picked object.", "Ang nai-format na value o napiling object."), outcomes: [tx("Formatted", "Nai-format"), tx("Failed, if the input is invalid", "Nabigo, kung hindi valid ang input")] },
  http: { app: null, mark: "globe", action: tx("HTTP request", "HTTP request sa web"), description: tx("Call a web address and keep its answer for the next steps.", "Tumawag sa web address at itago ang sagot para sa susunod na steps."), required: ["method", "url"], input: tx("A method and a web address, with optional headers and body.", "Isang method at web address, may headers at body kung kailangan."), output: tx("The response status and body.", "Ang status at body ng sagot."), outcomes: [tx("Answered", "Sumagot"), tx("Failed, retried when it is safe", "Nabigo, uulitin kapag ligtas")] },
  email: { app: GMAIL, mark: "gmail", provider: "gmail", action: tx("Send email", "Magpadala ng email"), description: tx("Send the message from the workspace's connected address.", "Ipadala ang mensahe mula sa naka-connect na address ng workspace."), required: ["to", "subject", "text"], input: tx("Recipient, subject and message.", "Tatanggap, subject at mensahe."), output: tx("Whether the email was sent.", "Kung naipadala ang email."), outcomes: [tx("Sent", "Naipadala"), tx("Failed, with the reason", "Nabigo, may dahilan")] },
  delay: { app: null, mark: "clock", action: tx("Delay", "Paghihintay"), description: tx("Wait a fixed time, or until a time from the request.", "Maghintay ng takdang oras, o hanggang sa oras mula sa request."), required: [], input: tx("Seconds, or a date and time with an offset.", "Segundo, o petsa at oras na may offset."), output: tx("Nothing. The run carries on later.", "Wala. Magpapatuloy ang run mamaya."), outcomes: [tx("Done waiting", "Tapos na ang paghihintay"), tx("Late, if the time already passed", "Huli na, kung lumipas na ang oras")] },
  ai: { app: null, mark: "ai", action: tx("AI task", "Gawain ng AI"), description: tx("Extract fields, classify or summarise text. The checks of kymavo decide what happens next.", "Kumuha ng fields, mag-uri o mag-buod ng text. Ang mga check ng kymavo ang magpapasya sa susunod."), required: ["task"], input: tx("Text from the request, and the fields or labels to look for.", "Text mula sa request, at ang fields o labels na hahanapin."), output: tx("The fields or the label the AI found.", "Ang fields o label na nakita ng AI."), outcomes: [tx("Answered", "Sumagot"), tx("Failed, with the reason", "Nabigo, may dahilan")] },
  approval: { app: null, mark: "person-check", action: tx("Approval", "Pag-apruba"), description: tx("Ask a named person to approve or reject, then follow their answer.", "Hilingin sa isang pinangalanang tao na aprubahan o tanggihan, saka sundan ang sagot."), required: ["subject", "message", "timeoutSeconds"], input: tx("Who decides, the message and how long to wait.", "Sino ang magpapasya, ang mensahe at gaano katagal maghihintay."), output: tx("The decision.", "Ang desisyon."), outcomes: [tx("Approved", "Inaprubahan"), tx("Rejected", "Tinanggihan"), tx("Timed out", "Lumipas ang oras")] },
  sheets: { app: SHEETS, mark: "google-sheets", provider: "google_sheets", action: tx("Add a row", "Magdagdag ng row"), description: tx("Add one row or a batch of rows to the sheet chosen in Apps.", "Magdagdag ng isang row o maraming row sa sheet na pinili sa Apps."), required: [], input: tx("Columns for one row, or a list of rows with an optional header.", "Mga column para sa isang row, o listahan ng mga row na may opsyonal na header."), output: tx("Whether the row or rows were added.", "Kung naidagdag ang row o mga row."), outcomes: queued },
  drive: { app: DRIVE, mark: "google-drive", provider: "google_drive", action: tx("Save files", "I-save ang mga file"), description: tx("Save the files people attached to a form in the Drive folder chosen in Apps.", "I-save ang mga file na inilagay sa form sa Drive folder na pinili sa Apps."), required: [], input: tx("The form's file fields.", "Ang mga file field ng form."), output: tx("Whether the files were saved.", "Kung na-save ang mga file."), outcomes: queued },
  slack: { app: tx("Slack", "Slack"), mark: "slack", provider: "slack", action: tx("Post a message", "Mag-post ng mensahe"), description: tx("Post a short note to the Slack channel chosen in Apps. Everyone in the channel can read it.", "Mag-post ng maikling note sa Slack channel na pinili sa Apps. Mababasa ito ng lahat sa channel."), required: ["text"], input: tx("The message text.", "Ang text ng mensahe."), output: tx("Whether the message was posted.", "Kung na-post ang mensahe."), outcomes: queued },
  outlook: { app: tx("Outlook", "Outlook"), mark: "outlook", provider: "outlook", action: tx("Send email", "Magpadala ng email"), description: tx("Send the message from the Outlook mailbox the owner connected.", "Ipadala ang mensahe mula sa Outlook mailbox na ikinonekta ng owner."), required: ["to", "subject", "text"], input: tx("Recipient, subject and message.", "Tatanggap, subject at mensahe."), output: tx("Whether the email was sent.", "Kung naipadala ang email."), outcomes: queued },
  teams: { app: tx("Microsoft Teams", "Microsoft Teams"), mark: "teams", provider: "teams", action: tx("Post a message", "Mag-post ng mensahe"), description: tx("Post a note to the Teams channel chosen in Apps. It is a notification only.", "Mag-post ng note sa Teams channel na pinili sa Apps. Abiso lang ito."), required: ["text"], input: tx("The message text.", "Ang text ng mensahe."), output: tx("Whether the message was posted.", "Kung na-post ang mensahe."), outcomes: queued },
  telegram: { app: TELEGRAM, mark: "telegram", provider: "telegram", action: tx("Send a message", "Magpadala ng mensahe"), description: tx("Send plain text to the Telegram chat chosen in Apps.", "Magpadala ng plain text sa Telegram chat na pinili sa Apps."), required: ["text"], input: tx("The message text.", "Ang text ng mensahe."), output: tx("Whether the message was sent.", "Kung naipadala ang mensahe."), outcomes: queued },
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
  stay_quote: { app: null, mark: "form", action: tx("Quote a stay", "Kuwentahin ang stay"), description: tx("Work out the price and deposit of a stay from the published knowledge sheet: nights across seasons, weekday rates and extra guests.", "Kuwentahin ang presyo at deposit ng stay mula sa na-publish na knowledge sheet: mga gabi sa iba't ibang season, presyo kada araw ng linggo at sobrang guest."), required: ["room", "checkIn", "nights", "guests"], input: tx("A room from the knowledge sheet, the check-in date, nights and guests.", "Isang room mula sa knowledge sheet, petsa ng check-in, bilang ng gabi at guests."), output: tx("Each night's price, the total and the deposit in pesos.", "Presyo ng bawat gabi, kabuuan at deposit sa piso."), outcomes: [tx("Quoted", "Nakuwenta"), tx("Failed, with the reason", "Nabigo, may dahilan")] },
  assistant_read: { app: null, mark: "form", action: tx("Read today's summary", "Basahin ang buod ngayon"), description: tx("Read-only snapshot of today's Google Calendar events, kymavo bookings, unpaid payments and today's runs.", "Read-only na buod ng mga event sa Google Calendar ngayon, mga booking sa kymavo, hindi pa bayad na singilin at mga run ngayon."), required: [], input: tx("Which area to read (all, calendar, bookings, payments or runs) and timezone.", "Aling bahagi ang babasahin (all, calendar, bookings, payments o runs) at timezone."), output: tx("Today's counts, items and a plain summary text.", "Mga bilang ngayon, item at simpleng buod na text."), outcomes: [tx("Read", "Nabasa"), tx("Failed, with the reason", "Nabigo, may dahilan")] },
  conversation_update: { app: null, mark: "form", action: tx("Save guest details", "I-save ang detalye ng guest"), description: tx("Save the dates, number of guests, name and contact the customer gave, so the run for their next message sees them.", "I-save ang petsa, bilang ng guests, pangalan at contact na ibinigay ng customer, para makita ito ng run ng susunod niyang mensahe."), required: ["fields"], input: tx("Check-in, check-out, guests, name, phone or email, usually from an AI step.", "Check-in, check-out, guests, pangalan, phone o email, kadalasan mula sa AI step."), output: tx("All details saved for this customer so far.", "Lahat ng detalyeng na-save para sa customer na ito."), outcomes: [tx("Saved", "Na-save"), tx("Failed, with the reason", "Nabigo, may dahilan")] },
  discord: { app: tx("Discord", "Discord"), mark: "discord", provider: "discord", action: tx("Post a message", "Mag-post ng mensahe"), description: tx("Post a short note to the Discord channel your webhook is for. Everyone in the channel can read it.", "Mag-post ng maikling note sa Discord channel ng iyong webhook. Mababasa ito ng lahat sa channel."), required: ["text"], input: tx("The message text, up to 2000 characters.", "Ang text ng mensahe, hanggang 2000 character."), output: tx("Whether the message was posted.", "Kung na-post ang mensahe."), outcomes: queued },
  google_docs: { app: DOCS, mark: "google-docs", provider: "google_drive", action: tx("Make a document", "Gumawa ng dokumento"), description: tx("Copy the template you pick here, fill in its {{placeholders}} and save the copy in the Drive folder chosen there.", "Kopyahin ang template na pipiliin mo rito, punan ang mga {{placeholder}} nito at i-save ang kopya sa Drive folder na pinili roon."), required: ["templateId", "name"], input: tx("A document name, and a value for each placeholder in the template.", "Pangalan ng dokumento, at value para sa bawat placeholder sa template."), output: tx("The new document's link, for later steps.", "Ang link ng bagong dokumento, para sa susunod na steps."), outcomes: [tx("Document made", "Nagawa ang dokumento"), tx("Failed, with the reason", "Nabigo, may dahilan")] },
  // Phase B1 (decision 0107).
  read_page: { app: null, mark: "globe", action: tx("Read a web page", "Magbasa ng web page"), description: tx("Read a public web page: its title, its text and, with a selector, one value such as a price. It tells you if that value changed since the last run.", "Magbasa ng pampublikong web page: ang title, ang text at, kung may selector, isang value gaya ng presyo. Sasabihin nito kung nagbago ang value mula sa huling run."), required: ["url"], input: tx("A web address, and optionally a CSS selector for one value.", "Isang web address, at puwedeng CSS selector para sa isang value."), output: tx("The page title, text and value, the value from the last run, and whether it changed.", "Ang title, text at value ng page, ang value sa huling run, at kung nagbago ito."), outcomes: [tx("Page read", "Nabasa ang page"), tx("Failed, with the reason", "Nabigo, may dahilan")] },
  shopify_create_product: { app: SHOPIFY, mark: "shopify", provider: "shopify", action: tx("Create a product", "Gumawa ng product"), description: tx("Add a product to the connected Shopify store, with its price and SKU. It starts as a draft unless you choose active.", "Magdagdag ng product sa naka-connect na Shopify store, kasama ang presyo at SKU. Draft muna ito maliban kung pipiliin mong active."), required: ["title"], input: tx("The title, and if you want, the description, price, SKU, status and a picture link.", "Ang pamagat, at kung gusto mo, ang paglalarawan, presyo, SKU, status at link ng larawan."), output: tx("Whether the product was saved, with its id and link in Shopify.", "Kung na-save ang product, kasama ang id at link nito sa Shopify."), outcomes: [...queued, tx("Needs review, if the outcome is unknown", "Kailangang suriin, kung hindi alam ang resulta")] },
  shopify_update_product: { app: SHOPIFY, mark: "shopify", provider: "shopify", action: tx("Update a product", "I-update ang product"), description: tx("Find a product by its id or SKU and change only the things you choose, such as the price or the title.", "Hanapin ang product sa id o SKU nito at baguhin lang ang mga pipiliin mo, gaya ng presyo o pamagat."), required: ["product"], input: tx("The product id or SKU, and the things to change.", "Ang product id o SKU, at ang mga babaguhin."), output: tx("Whether the product was saved, with its id and link in Shopify.", "Kung na-save ang product, kasama ang id at link nito sa Shopify."), outcomes: queued },
  browser: { app: null, mark: "globe", action: tx("Use a web page", "Gumamit ng web page"), description: tx("Open a public page in kymavo's browser, click, type and read values from it, and take screenshots. It never types a password or card number.", "Buksan ang public na page sa browser ng kymavo, mag-click, mag-type at magbasa ng value mula rito, at kumuha ng screenshot. Hindi ito nagta-type ng password o card number."), required: ["url"], input: tx("A web address and up to 20 actions.", "Isang web address at hanggang 20 action."), output: tx("The values it read, the last address and the screenshots.", "Ang mga value na nabasa nito, ang huling address at ang mga screenshot."), outcomes: [tx("Done", "Tapos"), tx("Failed, with the reason", "Nabigo, may dahilan")] },
  call_workflow: { app: null, mark: "play", action: tx("Call another automation", "Tumawag ng ibang automation"), description: tx("Start another published automation in your workspace whose trigger is Run from another automation.", "Magsimula ng isa pang naka-publish na automation sa workspace na may trigger na Patakbuhin mula sa ibang automation."), required: ["workflowSlug"], input: tx("Target automation slug and payload fields.", "Slug ng target automation at payload fields."), output: tx("The started child run id and workflow details.", "Ang id ng sinimulang child run at detalye ng workflow."), outcomes: [tx("Started", "Nagsimula"), tx("Failed, with the reason", "Nabigo, may dahilan")] },
};

export const TRIGGER_CATALOG: Record<Trigger["type"], CatalogEntry> = {
  manual: { app: null, mark: "play", action: tx("You run it", "Ikaw ang magpapatakbo"), description: tx("Start the automation yourself with sample data.", "Simulan ang automation mismo gamit ang sample data."), required: [], input: tx("Whatever you type as sample data.", "Anumang i-type mo bilang sample data."), output: tx("The sample data.", "Ang sample data."), outcomes: [tx("Started", "Nagsimula")] },
  email: { app: null, mark: "mail", action: tx("An email arrives", "May dumating na email"), description: tx("Start when a message reaches the mailbox set up for this automation.", "Magsimula kapag may mensaheng dumating sa mailbox na itinakda para sa automation na ito."), required: [], input: tx("The email: sender, subject and text.", "Ang email: nagpadala, subject at text."), output: tx("The email as trigger fields.", "Ang email bilang trigger fields."), outcomes: [tx("Started", "Nagsimula")] },
  webhook: { app: null, mark: "link", action: tx("A system sends an event", "May system na nagpadala ng event"), description: tx("Start when another system calls the kymavo address with data.", "Magsimula kapag tumawag ang ibang system sa address ng kymavo na may data."), required: [], input: tx("The data the other system sends.", "Ang data na ipinapadala ng ibang system."), output: tx("The data as trigger fields.", "Ang data bilang trigger fields."), outcomes: [tx("Started", "Nagsimula"), tx("Refused, if the signature is wrong", "Tinanggihan, kung mali ang signature")] },
  schedule: { app: null, mark: "clock", action: tx("On a schedule", "Ayon sa iskedyul"), description: tx("Start at the times in the schedule, such as every Monday at 9.", "Magsimula sa mga oras ng iskedyul, gaya ng bawat Lunes ng alas-9."), required: [], input: tx("A schedule.", "Isang iskedyul."), output: tx("The time it started.", "Ang oras ng pagsisimula."), outcomes: [tx("Started", "Nagsimula")] },
  form: { app: null, mark: "form", action: tx("A form is submitted", "May nag-submit ng form"), description: tx("Start when someone sends the form. Each request gets a reference.", "Magsimula kapag may nagpadala ng form. May reference ang bawat request."), required: ["fields"], input: tx("The form's fields.", "Ang mga field ng form."), output: tx("The answers as trigger fields.", "Ang mga sagot bilang trigger fields."), outcomes: [tx("Started", "Nagsimula"), tx("Refused, if a field is invalid", "Tinanggihan, kung may maling field")] },
  payment: { app: PAYMONGO, mark: "paymongo", provider: "paymongo", action: tx("A payment is reported", "May naiulat na bayad"), description: tx("Start when PayMongo reports a payment that kymavo has checked.", "Magsimula kapag may iniulat na bayad ang PayMongo na na-check ng kymavo."), required: [], input: tx("A verified PayMongo event.", "Isang beripikadong PayMongo event."), output: tx("The payment as trigger fields.", "Ang bayad bilang trigger fields."), outcomes: [tx("Started", "Nagsimula")] },
  meta_dm: { app: META, mark: "messenger", provider: "meta_messenger", action: tx("A customer sends a message", "May customer na nagpadala ng mensahe"), description: tx("Start when a Messenger or Instagram DM arrives on the connected account.", "Magsimula kapag may DM sa Messenger o Instagram sa naka-connect na account."), required: [], input: tx("The message and any photos.", "Ang mensahe at mga larawan."), output: tx("The message as trigger fields.", "Ang mensahe bilang trigger fields."), outcomes: [tx("Started", "Nagsimula")] },
  telegram_message: { app: TELEGRAM, mark: "telegram", provider: "telegram", action: tx("Someone messages your bot", "May nag-message sa bot mo"), description: tx("Start when a photo, PDF or message reaches your own Telegram bot, from your chat only or from anyone.", "Magsimula kapag may photo, PDF o mensahe sa sarili mong Telegram bot, mula sa chat mo lang o mula sa kahit sino."), required: [], input: tx("The message and any photo or PDF.", "Ang mensahe at anumang photo o PDF."), output: tx("The message, the sender's chat and the file.", "Ang mensahe, ang chat ng nagpadala at ang file."), outcomes: [tx("Started", "Nagsimula")] },
  shopify_order: { app: SHOPIFY, mark: "shopify", provider: "shopify", action: tx("A Shopify order comes in", "May pumasok na order sa Shopify"), description: tx("Start for each new order in the connected Shopify store. kymavo checks Shopify's signature first.", "Magsimula sa bawat bagong order sa naka-connect na Shopify store. Sinusuri muna ng kymavo ang signature ng Shopify."), required: [], input: tx("The order: number, customer, total and items.", "Ang order: numero, customer, total at mga item."), output: tx("The order as trigger fields.", "Ang order bilang trigger fields."), outcomes: [tx("Started", "Nagsimula")] },
  booking_event: { app: null, mark: "calendar", action: tx("A booking changes", "May nagbago sa booking"), description: tx("Start when a kymavo booking is created, rescheduled or cancelled.", "Magsimula kapag may ginawa, nilipat o kinanselang kymavo booking."), required: [], input: tx("Booking id, reference, resource and schedule.", "Booking id, reference, resource at iskedyul."), output: tx("The booking event details as trigger fields.", "Ang detalye ng booking event bilang trigger fields."), outcomes: [tx("Started", "Nagsimula")] },
  payment_event: { app: null, mark: "form", action: tx("A payment due settles", "Nabayaran o napaso ang due"), description: tx("Start when a kymavo payment due is confirmed or expires unpaid.", "Magsimula kapag nakumpirma o napaso ang isang kymavo payment due."), required: [], input: tx("Payment due id, reference, amount and status.", "Payment due id, reference, halaga at status."), output: tx("The payment due details as trigger fields.", "Ang detalye ng payment due bilang trigger fields."), outcomes: [tx("Started", "Nagsimula")] },
  sub_workflow: { app: null, mark: "play", action: tx("Called by another automation", "Tinawag ng ibang automation"), description: tx("Reusable automation started by a Call another automation step in the same workspace.", "Magagamit muling automation na sinisimulan ng Call another automation step sa parehong workspace."), required: [], input: tx("Fields passed by the parent automation.", "Mga field na ipinasa ng parent automation."), output: tx("The passed fields as trigger fields.", "Ang ipinasang fields bilang trigger fields."), outcomes: [tx("Started", "Nagsimula")] },
  // G2 (decision 0127): read by a poll, so a run starts within a few minutes of the change.
  sheets_row: { app: SHEETS, mark: "google-sheets", provider: "google_sheets", action: tx("A row is added", "May nadagdag na row"), description: tx("Start for each new row in a tab of the sheet chosen in Apps. kymavo checks every few minutes.", "Magsimula sa bawat bagong row sa isang tab ng sheet na pinili sa Apps. Tumitingin ang kymavo kada ilang minuto."), required: ["tab"], input: tx("The tab to watch.", "Ang tab na babantayan."), output: tx("The row's values, named after the header row.", "Ang mga value ng row, ayon sa header row."), outcomes: [tx("Started", "Nagsimula")] },
  calendar_event: { app: CALENDAR, mark: "google-calendar", provider: "google_calendar", action: tx("An event is added or starts soon", "May bagong event o malapit nang magsimula"), description: tx("Start for each new event in the calendar chosen in Apps, or a set time before an event starts.", "Magsimula sa bawat bagong event sa calendar na pinili sa Apps, o ilang minuto bago magsimula ang event."), required: [], input: tx("New events, or how long before the start.", "Bagong event, o gaano katagal bago magsimula."), output: tx("The event's title, time, place and link.", "Ang pamagat, oras, lugar at link ng event."), outcomes: [tx("Started", "Nagsimula")] },
  drive_file: { app: DRIVE, mark: "google-drive", provider: "google_drive", action: tx("A file is added", "May nadagdag na file"), description: tx("Start for each new file in the Drive folder chosen in Apps. Photos and PDFs up to 5 MB come along for later steps.", "Magsimula sa bawat bagong file sa Drive folder na pinili sa Apps. Kasama ang mga photo at PDF hanggang 5 MB para sa susunod na mga step."), required: [], input: tx("The folder chosen in Apps.", "Ang folder na pinili sa Apps."), output: tx("The file's name, type, size and link, and the file itself when it fits.", "Ang pangalan, uri, laki at link ng file, at ang file mismo kung kasya."), outcomes: [tx("Started", "Nagsimula")] },
  // G3 (decision 0132): connected mailbox triggers on existing Gmail and Outlook OAuth grants.
  gmail_message: { app: GMAIL, mark: "gmail", provider: "gmail", action: tx("A Gmail message arrives", "May dumating na mensahe sa Gmail"), description: tx("Start when an email arrives in your connected Gmail mailbox. Optional filters match sender, subject or label.", "Magsimula kapag may dumating na email sa naka-connect mong Gmail mailbox. Puwedeng mag-filter ayon sa nagpadala, subject o label."), required: [], input: tx("Optional sender, subject or label filters.", "Opsyonal na filter sa nagpadala, subject o label."), output: tx("The email: sender, recipients, subject, text, message id and date.", "Ang email: nagpadala, mga tatanggap, subject, text, message id at petsa."), outcomes: [tx("Started", "Nagsimula")] },
  outlook_message: { app: OUTLOOK, mark: "outlook", provider: "outlook", action: tx("An Outlook message arrives", "May dumating na mensahe sa Outlook"), description: tx("Start when an email arrives in your connected Outlook mailbox. Optional filters match sender, subject or folder.", "Magsimula kapag may dumating na email sa naka-connect mong Outlook mailbox. Puwedeng mag-filter ayon sa nagpadala, subject o folder."), required: [], input: tx("Optional sender, subject or folder filters.", "Opsyonal na filter sa nagpadala, subject o folder."), output: tx("The email: sender, recipients, subject, text, message id and date.", "Ang email: nagpadala, mga tatanggap, subject, text, message id at petsa."), outcomes: [tx("Started", "Nagsimula")] },
  // G4 (decision 0133): public page / RSS monitor and verified team chat triggers.
  page_changed: { app: null, mark: "globe", action: tx("A web page or feed changes", "May nagbago sa web page o feed"), description: tx("Check a public web page or RSS/Atom feed on a schedule. Starts when the page value changes or a new feed item appears.", "Suriin ang pampublikong web page o RSS/Atom feed nang regular. Magsisimula kapag nagbago ang value o may bagong item sa feed."), required: ["url"], input: tx("A public web address, and optionally a CSS selector or feed mode.", "Isang pampublikong web address, at puwedeng CSS selector o feed mode."), output: tx("The page title, value and previous value, or the new feed item's title, link and summary.", "Ang title, value at nakaraang value ng page, o ang title, link at buod ng bagong item sa feed."), outcomes: [tx("Started", "Nagsimula")] },
  slack_message: { app: tx("Slack", "Slack"), mark: "slack", action: tx("A Slack message arrives", "May dumating na mensahe sa Slack"), description: tx("Start when Slack sends a signed message event to kymavo's Slack webhook address.", "Magsimula kapag nagpadala ang Slack ng naka-sign na message event sa Slack webhook address ng kymavo."), required: ["signingSecret"], input: tx("A Slack signing secret name and optional channel or keyword filter.", "Pangalan ng Slack signing secret at opsyonal na filter sa channel o salita."), output: tx("The message text, channel, sender and timestamp as trigger fields.", "Ang text ng mensahe, channel, nagpadala at timestamp bilang trigger fields."), outcomes: [tx("Started", "Nagsimula"), tx("Refused, if the signature is wrong", "Tinanggihan, kung mali ang signature")] },
  teams_message: { app: tx("Microsoft Teams", "Microsoft Teams"), mark: "teams", action: tx("A Teams message arrives", "May dumating na mensahe sa Teams"), description: tx("Start when Microsoft Teams sends a signed outgoing webhook or workflow event to kymavo.", "Magsimula kapag nagpadala ang Microsoft Teams ng naka-sign na outgoing webhook o workflow event sa kymavo."), required: ["signingSecret"], input: tx("A signing secret name and optional channel or keyword filter.", "Pangalan ng signing secret at opsyonal na filter sa channel o salita."), output: tx("The message text, sender, channel and timestamp as trigger fields.", "Ang text ng mensahe, nagpadala, channel at timestamp bilang trigger fields."), outcomes: [tx("Started", "Nagsimula"), tx("Refused, if the signature is wrong", "Tinanggihan, kung mali ang signature")] },
  discord_message: { app: tx("Discord", "Discord"), mark: "discord", action: tx("A Discord command or message arrives", "May dumating na command o mensahe sa Discord"), description: tx("Start when Discord sends a verified slash command interaction or signed message event to kymavo.", "Magsimula kapag nagpadala ang Discord ng beripikadong slash command interaction o naka-sign na message event sa kymavo."), required: [], input: tx("A Discord public key or signing secret name, and optional filters.", "Discord public key o pangalan ng signing secret, at mga opsyonal na filter."), output: tx("The command, text, channel, sender and options as trigger fields.", "Ang command, text, channel, nagpadala at mga option bilang trigger fields."), outcomes: [tx("Started", "Nagsimula"), tx("Refused, if the signature is wrong", "Tinanggihan, kung mali ang signature")] },
  // G5 (decision 0134): read by a poll, so a run starts within a few minutes of the change.
  airtable_record: { app: AIRTABLE, mark: "airtable", provider: "airtable", action: tx("A record is added or changes status", "May bagong record o nagbago ang status"), description: tx("Start for each new record or status change in the Airtable table chosen in Apps. kymavo checks every few minutes.", "Magsimula sa bawat bagong record o pagbabago ng status sa Airtable table na pinili sa Apps. Tumitingin ang kymavo kada ilang minuto."), required: [], input: tx("New records, or the status field to watch.", "Mga bagong record, o ang status field na babantayan."), output: tx("The record id and its field values.", "Ang record id at ang mga value ng field nito."), outcomes: [tx("Started", "Nagsimula")] },
  notion_page: { app: NOTION, mark: "notion", provider: "notion", action: tx("A page is added or changes status", "May bagong page o nagbago ang status"), description: tx("Start for each new page or status change in the Notion database chosen in Apps. kymavo checks every few minutes.", "Magsimula sa bawat bagong page o pagbabago ng status sa Notion database na pinili sa Apps. Tumitingin ang kymavo kada ilang minuto."), required: [], input: tx("New pages, or the status property to watch.", "Mga bagong page, o ang status property na babantayan."), output: tx("The page title, link and properties.", "Ang pamagat, link at mga property ng page."), outcomes: [tx("Started", "Nagsimula")] },
  trello_card: { app: TRELLO, mark: "trello", provider: "trello", action: tx("A card is added or moved to the list", "May bagong card o inilipat sa list"), description: tx("Start for each card added to or moved into the Trello list chosen in Apps. kymavo checks every few minutes.", "Magsimula sa bawat card na idinagdag o inilipat sa Trello list na pinili sa Apps. Tumitingin ang kymavo kada ilang minuto."), required: [], input: tx("Cards added or moved into the list chosen in Apps.", "Mga card na idinagdag o inilipat sa list na pinili sa Apps."), output: tx("The card name, description, link and list details.", "Ang pangalan, paglalarawan, link at detalye ng list ng card."), outcomes: [tx("Started", "Nagsimula")] },
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
  shopify_order: tx("the order", "order"),
  telegram_message: tx("the Telegram message", "Telegram message"),
  booking_event: tx("the booking event", "booking event"),
  payment_event: tx("the payment event", "payment event"),
  sub_workflow: tx("the parent automation", "parent automation"),
  sheets_row: tx("the new row", "bagong row"),
  calendar_event: tx("the calendar event", "calendar event"),
  drive_file: tx("the Drive file", "Drive file"),
  discord_message: tx("the Discord message", "Discord message"),
  airtable_record: tx("the Airtable record", "Airtable record"),
  notion_page: tx("the Notion page", "Notion page"),
  trello_card: tx("the Trello card", "Trello card"),
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
      const fields = trigger && (trigger.type === "form" || trigger.type === "webhook" || trigger.type === "sub_workflow") ? trigger.config.fields ?? [] : [];
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
    case "discord":
      return picked(label("Channel", "Channel"));
    case "google_docs":
      return picked(label("Folder", "Folder"));
    case "read_page": {
      let host = step.config.url;
      try { host = new URL(step.config.url).host || host; } catch { /* a template in the address: show it as typed */ }
      return line(label("Reads", "Babasahin"), short(host));
    }
    case "telegram":
      return step.config.chatId === undefined ? picked(label("Chat", "Chat")) : line(label("Chat", "Chat"), pick(label("the sender", "ang nagpadala"), language));
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
    case "conversation_update":
      return line(label("Saves", "Ise-save"), Object.keys(step.config.fields).join(", "));
    case "stay_quote":
      return line(label("Room", "Room"), short(human(step.config.room, ctx)));
    case "assistant_read":
      return line(label("Reads", "Babasahin"), short(human(step.config.what, ctx)));
    case "shopify_create_product":
      return line(label("Product", "Product"), short(human(step.config.title, ctx)));
    case "shopify_update_product":
      return line(label("Product", "Product"), short(human(step.config.product, ctx)));
    case "browser": {
      let host = step.config.url;
      try { host = new URL(step.config.url).host || host; } catch { /* a template in the address: show it as typed */ }
      return line(label("Opens", "Bubuksan"), short(host));
    }
    case "http": {
      let host = step.config.url;
      try { host = new URL(step.config.url).host || host; } catch { /* a template in the address: show it as typed */ }
      return line(label("Calls", "Tatawag sa"), `${step.config.method} ${short(host)}`);
    }
    case "condition":
      return line(label("If", "Kung"), short(`${human(step.config.condition.left, ctx)} ${step.config.condition.op} ${human(String(step.config.condition.right ?? ""), ctx)}`.trim()));
    case "switch":
      return line(label("Match", "Itugma"), short(`${human(step.config.value ?? "", ctx)} (${step.config.cases?.length ?? 0})`));
    case "transform":
      return line(label("Transform", "I-format"), step.config.op === "pick" ? Object.keys(step.config.fields ?? {}).join(", ") : short(`${step.config.op}: ${human(step.config.value ?? "", ctx)}`));
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
    case "call_workflow":
      return line(label("Runs", "Patatakbuhin"), short(step.config.workflowSlug));
  }
}

/** The label of a kymavo line icon or app when no picture is available, so every mark has text. */
export const markText = (e: CatalogEntry, language: Language): string => (e.app ? pick(e.app, language) : pick(e.action, language));
