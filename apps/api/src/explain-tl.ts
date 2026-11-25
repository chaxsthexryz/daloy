import type { Explanation, Facts, AskFacts } from "./explain";
import type { LintRule } from "@daloy/engine";

const lint: Record<LintRule, string> = {
  approval_no_edge: "May approval sa automation na walang susunod na hakbang para sa isa sa mga sagot, kaya doon ito matatapos.",
  classify_dead_end: "Maaaring magbigay ang AI sort ng sagot na walang kasunod na hakbang, kaya doon matatapos ang automation.",
  test_switch: "May switch sa automation na mukhang pang-preview. Tingnan kung tama ang pagkaka-set nito.",
  number_no_invalid: "May number check na walang kasunod na hakbang kapag hindi numero ang halaga, kaya doon matatapos ang automation.",
  unreachable_step: "May bahagi ng automation na hindi maaabot, kaya hindi ito tatakbo.",
};
const apps: Record<string, string> = { google_sheets: "Google Sheets", slack: "Slack", outlook: "Outlook", teams: "Microsoft Teams", discord: "Discord", telegram: "Telegram", unisms: "UniSMS", google_calendar: "Google Calendar", google_drive: "Google Drive", airtable: "Airtable", notion: "Notion", trello: "Trello", meta_messenger: "Facebook Messenger & Instagram", shopify: "Shopify" };
const appsFix = { href: "#/apps", label: "Tingnan ang koneksyon" };
const booking: Explanation = { headline: "Isinara ito dahil nagbago ang booking.", lines: ["Na-reschedule o nakansela ang booking, kaya wala nang ipapadala."], fix: null };
const permission: Record<string, string> = {
  google_sheets: "I-share ang sheet sa Google account na ikinonekta mo, saka pindutin ang Subukan ulit.",
  slack: "Imbitahan ang kymavo app sa channel, saka pindutin ang Subukan ulit.",
  outlook: "Tingnan kung puwedeng magpadala ng email ang nakakonektang Outlook account, saka pindutin ang Subukan ulit.",
  teams: "Idagdag ang nakakonektang account sa team at channel, saka pindutin ang Subukan ulit.",
  discord: "Tingnan kung pinapayagan pa ng channel ang webhook, o mag-paste ng bagong webhook link sa Apps, saka pindutin ang Subukan ulit.",
  google_calendar: "I-share ang calendar sa Google service account na ikinonekta mo, piliin ang Make changes to events, saka pindutin ang Subukan ulit.",
  airtable: "Bigyan ng access ang Airtable token sa base at table na iyon, saka pindutin ang Subukan ulit.",
  notion: "I-share ang database sa Notion integration, saka pindutin ang Subukan ulit.",
  trello: "Tiyaking puwedeng mag-edit ang Trello token sa board na iyon, saka pindutin ang Subukan ulit.",
  meta_messenger: "Tingnan ang messaging permissions ng Page sa Meta, saka pindutin ang Subukan ulit.",
};
function delivery(d: Facts["deliveries"][number]): Explanation | null {
  const app = apps[d.provider] ?? "Ang kabilang app";
  const sent = d.provider === "outlook" || d.provider === "unisms" || d.provider === "meta_messenger";
  const where = d.provider === "google_sheets" ? "sheet" : d.provider === "google_calendar" ? "calendar" : d.provider === "unisms" ? "Sender ID" : d.provider === "meta_messenger" ? "page" : "channel";
  const done = sent ? "Markahang naipadala" : "Markahang nai-post";
  const again = sent ? "Ipadala ulit" : "I-post ulit";
  const check = d.provider === "outlook" ? "Tingnan ang Sent Items" : `Tingnan ang ${app}`;
  const review = (why: string): Explanation => ({ headline: "Kailangan mo itong tingnan bago magpatuloy.", lines: [why, `${check}. Kung naroon, pindutin ang ${done}. Kung wala, pindutin ang ${again}.`], fix: null });
  switch (d.errorKind) {
    case "auth": case "reconnect": return { headline: `Kailangang ikonekta muli ang ${app}.`, lines: [`Hindi na tinatanggap ng ${app} ang access ng kymavo. Ikonekta muli ito sa Apps, saka pindutin ang Subukan ulit.`], fix: appsFix };
    case "not_connected": return { headline: `Hindi nakakonekta ang ${app}.`, lines: [`Ikonekta ang ${app} sa Apps, saka pindutin ang Subukan ulit.`], fix: { href: "#/apps", label: `Ikonekta ang ${app}` } };
    case "permission": return { headline: `Tinanggihan ng ${app} ang kymavo.`, lines: [permission[d.provider] ?? "Bigyan ng access ang nakakonektang account, saka pindutin ang Subukan ulit."], fix: appsFix };
    case "no_destination": return { headline: `Walang napiling ${where} para sa ${app}.`, lines: [`Pumili ng ${where} sa Apps, saka pindutin ang Subukan ulit.`], fix: { href: "#/apps", label: `Pumili ng ${where}` } };
    case "plan_quota": return { headline: "Naabot na ang limit ng plan.", lines: ["Naubos na ng opisina ang kasalukuyang pinapayagan ng plan nito. Pindutin ang Subukan ulit kapag nag-reset na ang limit."], fix: { href: "#/settings", label: "Tingnan ang nagamit" } };
    case "quota": case "unavailable": return { headline: `Abala ang ${app} o nililimitahan nito ang mga request.`, lines: [`Kusang susubok muli ang kymavo. Wala ka munang kailangang gawin (${d.attempts} beses nang sinubukan).`], fix: null };
    case "ambiguous": case "review": return review(`Hindi malinaw ang sagot ng ${app} kung natuloy ito.`);
    case "destination_changed": return review(`Nabago ang ${where} para sa ${app} matapos itong mailagay sa pila, kaya hindi ito ipinadala ng kymavo.`);
    case "queued_before_pin": return review(`Nailagay ito sa pila bago naitala ng kymavo ang gagamiting ${where}, kaya hindi ito ipinadala.`);
    case "invalid": return { headline: `Tinanggihan ito ng ${app}.`, lines: [`Hindi tinanggap ng ${app} ang ipinadala ng kymavo. Tingnan ang settings ng hakbang na ito sa automation.`], fix: null };
    case "booking_changed": return booking;
    default: return null;
  }
}
function step(s: NonNullable<Facts["step"]>): Explanation | null {
  switch (s.reason) {
    case "mail_sender": return { headline: "Hindi naipadala ang email.", lines: ["Hindi magamit ng kymavo ang nakakonektang email account. Ikonekta muli ang Gmail, saka pindutin ang Subukan ulit."], fix: { href: "#/apps", label: "Ikonekta ang Gmail" } };
    case "ai_model": return { headline: "Hindi sumagot ang AI model.", lines: ["Hindi maabot ng kymavo ang AI model, o tinanggihan ang key nito. Tingnan ang AI model, saka pindutin ang Subukan ulit."], fix: { href: "#/settings/ai", label: "Tingnan ang AI model" } };
    case "quota": return { headline: "Naabot na ang limit ng plan.", lines: ["Naubos na ng opisina ang kasalukuyang pinapayagan ng plan nito. Pindutin ang Subukan ulit kapag nag-reset na ang limit."], fix: { href: "#/settings", label: "Tingnan ang nagamit" } };
    case "booking_changed": return booking;
    case "worker_stopped": return { headline: "Huminto ang kymavo habang nagpapadala.", lines: ["Maaaring natuloy ito. Tanungin ang tatanggap, saka piliin ang Nakarating na, Ipadala ulit o Ihinto."], fix: null };
    case "preview_choice": return { headline: "Sadyang pinatigil ang preview na ito.", lines: ["Walang ipinadala. Baguhin ang pinili sa preview para makitang magpatuloy ang automation."], fix: null };
  }
  const code = s.statusCode;
  const http = code === 401 || code === 403 ? "tinanggihan ng kabilang serbisyo ang access ng kymavo" : code === 404 ? "hindi makita ang address" : code === 429 ? "pinapabagal ng kabilang serbisyo ang kymavo" : code && code >= 500 ? "nagkaproblema ang kabilang serbisyo" : null;
  if (http) return { headline: `Hindi natuloy ang request: ${http}.`, lines: [`Sumagot ang kabilang serbisyo ng ${code}. ${s.deadLetter ? `${s.attempts} beses sinubukan ng kymavo. ` : ""}Tingnan ang settings ng request, saka pindutin ang Subukan ulit.`], fix: null };
  if (s.deadLetter) return { headline: "Huminto ang kymavo matapos sumubok muli.", lines: [`Pumalya ang hakbang nang ${s.attempts} beses, kaya tumigil ang kymavo sa pagsubok. Pindutin ang Subukan ulit kapag naayos na ang dahilan.`], fix: null };
  if (s.outcome === "unknown") return { headline: "Hindi malinaw kung natuloy ito.", lines: ["Tanungin ang tatanggap, saka piliin ang Nakarating na, Ipadala ulit o Ihinto."], fix: null };
  if (s.outcome === "not_sent") return { headline: "Walang ipinadala.", lines: ["Huminto ang kymavo bago lumabas ang request. Pindutin ang Subukan ulit para subukan muli."], fix: null };
  if (s.outcome === "rejected") return { headline: "Tinanggihan ng kabilang serbisyo ang request.", lines: ["Tingnan ang settings ng hakbang sa automation, saka pindutin ang Subukan ulit."], fix: null };
  if (s.outcome === "throttled") return { headline: "Pinapabagal ng kabilang serbisyo ang kymavo.", lines: ["Pindutin ang Subukan ulit pagkalipas ng ilang minuto."], fix: null };
  return null;
}
export function explainFailureTl(facts: Facts): Explanation {
  const base = facts.deliveries.map(delivery).find(Boolean) ?? (facts.step ? step(facts.step) : null) ?? { headline: "Hindi matukoy ng kymavo kung bakit ito huminto.", lines: ["Nasa detalye para sa technician sa ibaba ang buong tala."], fix: null };
  return { ...base, lines: [...base.lines, ...facts.lint.map((l) => lint[l.rule])] };
}
const types: Record<string, string> = { condition: "Kondisyon", switch: "Pumili ng daan", transform: "I-format ang data", http: "HTTP request", browser: "Gumamit ng web page", email: "Magpadala ng email", delay: "Paghihintay", ai: "AI task", approval: "Pag-apruba", sheets: "Idagdag sa Google Sheets", drive: "I-save ang mga file sa Google Drive", slack: "I-post sa Slack", outlook: "Ipadala mula sa Outlook", teams: "I-post sa Teams", discord: "I-post sa Discord", google_docs: "Gumawa ng dokumento sa Google Docs", read_spreadsheet: "Basahin ang spreadsheet mula sa Google Drive", read_page: "Magbasa ng web page", telegram: "Ipadala sa Telegram", sms: "Magpadala ng SMS", calendar: "Idagdag sa Google Calendar", paymongo_link: "Gumawa ng payment link", payment_status: "Tingnan ang bayad", airtable: "Idagdag sa Airtable", notion: "Idagdag sa Notion", trello: "Idagdag sa Trello", booking: "Booking", meta_reply: "Sumagot sa Messenger o Instagram", conversation_update: "I-save ang detalye ng guest", stay_quote: "Kuwentahin ang stay", assistant_read: "Basahin ang buod ngayon", shopify_create_product: "Gumawa ng product sa Shopify", shopify_update_product: "Mag-update ng product sa Shopify", payment_due: "Humingi ng bayad", payment_expire: "Kanselahin kung hindi bayad", call_workflow: "Tumawag ng ibang automation" };
const headlines = { "needs you": "Kailangan mong tingnan ang request na ito bago magpatuloy.", done: "Tapos na ang request na ito.", problem: "Huminto ang request na ito dahil may problema.", waiting: "Naghihintay ang request na ito.", "in progress": "Tumatakbo pa ang request na ito." };
export function answerAllTl(facts: AskFacts): { happened: Explanation; why: Explanation | null; next: Explanation } {
  const happened = [facts.steps.length ? `${facts.steps.length} hakbang ang tumakbo.` : "Wala pang tumatakbong hakbang."];
  if (facts.step) happened.push(`Huminto ito sa: ${types[facts.step.type] ?? "isang hakbang"}.`);
  const stuck = (state: string) => state === "failed" || state === "needs_review";
  const why = stuck(facts.runState) || facts.deliveries.some((d) => stuck(d.state)) ? explainFailureTl(facts) : null;
  const open = "Buksan ang request sa Activity para makita ang bawat hakbang.";
  const next = why ? { headline: "Ano ang susunod na gagawin.", lines: [...why.lines, open], fix: why.fix } : { headline: "Ano ang susunod na gagawin.", lines: ["Wala kang kailangang gawin.", ...facts.lint.map((l) => lint[l.rule]), open], fix: null };
  return { happened: { headline: headlines[facts.plainState], lines: happened, fix: null }, why, next };
}
