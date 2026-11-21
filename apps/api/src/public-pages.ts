import type { FormField } from "@daloy/engine";

/**
 * The look of the public pages: forms, receipts, approvals (Doop rows E7 to E10, frames APOh0l4BzS, 3VWc5SBBJb,
 * rVgq6-LV9G, n0lqJe7pIU, fA3nGcTh7N, oeCtvge9o9, rtw6EaGxyf, IpTkhV7dCm, T4vwqK9vnk and the phone frames).
 * Plain server-rendered HTML with one inline stylesheet: the pages run under script-src 'self' and need no script.
 * They carry the business brand (logo, accent, name) and never the Daloy brand, except an approval with no brand set.
 */

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

/** What the owner's brand adds to a public page. accent is a checked #rrggbb and ink the readable text colour on it. */
export type PageBrand = { id: string; name: string | null; accent: string | null; ink: string | null; logo: boolean };

type Language = "en" | "tl";

const HEX = /^#[0-9a-f]{6}$/i;
/** Values here go into a style block, so anything that is not #rrggbb is replaced, whatever the database holds. */
export const safeColour = (value: string | null | undefined, fallback: string) => (value && HEX.test(value) ? value : fallback);

/** A message from parsePayload reads "field: reason". Messages for a field of the form go beside it, the rest stay general. */
export function splitErrors(errors: string[], names: string[]) {
  const byField = new Map<string, string>();
  const general: string[] = [];
  for (const e of errors) {
    const at = e.indexOf(": ");
    const name = at > 0 ? e.slice(0, at) : "";
    if (names.includes(name)) {
      if (!byField.has(name)) byField.set(name, e.slice(at + 2));
    } else general.push(e);
  }
  return { byField, general };
}

// Short answers sit two to a row on a wide page, as in the approved form frame.
const SHORT = new Set(["number", "email"]);
export function groupFields(fields: FormField[]): FormField[][] {
  const rows: FormField[][] = [];
  for (const f of fields) {
    const last = rows[rows.length - 1];
    if (SHORT.has(f.type) && last && last.length === 1 && SHORT.has(last[0]!.type)) last.push(f);
    else rows.push([f]);
  }
  return rows;
}

const CSS = `@font-face{font-family:"Inter";src:url(/fonts/inter-variable.woff2) format("woff2");font-weight:100 900;font-display:swap}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px 18px;background:#f5f6f8;color:#0a0b0f;font:14px/20px "Inter",system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
body.embed{display:block;min-height:0;padding:4px;background:transparent}
h1,p{margin:0}
main{width:min(560px,100%);display:flex;flex-direction:column;gap:18px;padding:32px;background:#fff;border:1px solid #e3e6ec;border-radius:12px;animation:rise .2s cubic-bezier(.32,.72,0,1)}
h1{font-size:24px;line-height:30px;font-weight:700;letter-spacing:-.02em}
.ruled h1{border-bottom:4px solid var(--accent);padding-bottom:10px}
header img{display:block;max-height:48px;max-width:240px;border-radius:10px}
a{color:var(--accent);font-weight:600;text-underline-offset:3px}
form{display:flex;flex-direction:column;gap:16px;margin:0}
.f{display:flex;flex-direction:column;gap:6px;min-width:0}
.row{display:flex;gap:16px}
.row>.f{flex:1}
.row>.f:last-child{flex:1.4}
label{font-size:13px;line-height:18px;font-weight:600}
input,select,textarea{width:100%;height:40px;padding:0 12px;font:inherit;font-size:14px;color:#0a0b0f;background:#fff;border:1px solid #d5d9e2;border-radius:7px}
textarea{height:96px;padding:10px 12px;resize:vertical}
input[type=file]{height:auto;padding:8px 12px;font-size:13px;color:#3a3f4b}
input[type=file]::file-selector-button{margin-right:12px;padding:4px 10px;font:inherit;font-size:13px;font-weight:600;color:#0a0b0f;background:#f5f6f8;border:1px solid #d5d9e2;border-radius:6px;cursor:pointer}
:is(input,select,textarea,button,a):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.bad{border-color:#b42318;box-shadow:0 0 0 1px #b42318}
.er{font-size:12px;line-height:16px;font-weight:600;color:#b42318}
.hint{font-size:12px;line-height:16px;color:#5b6170}
.btn{align-self:flex-start;padding:.6em 1.2em;font:inherit;font-size:14px;font-weight:600;color:var(--on);background:var(--accent);border:0;border-radius:4px;cursor:pointer;text-decoration:none;transition:opacity .1s cubic-bezier(.32,.72,0,1)}
.btn:hover{opacity:.9}
.btn.ghost{color:#0a0b0f;background:#fff;border:1px solid #d5d9e2}
.alert{display:flex;flex-direction:column;gap:6px;padding:12px 14px;background:#fce9e9;border:1px solid #f4b4ae;border-radius:8px}
.alert b{font-size:13px;line-height:18px;color:#b42318}
.alert div{font-size:13px;line-height:18px;color:#3a3f4b}
.receipt{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;background:color-mix(in srgb,var(--accent) 12%,#fff);border-radius:8px}
.receipt .k{display:block;font-size:12px;line-height:16px;font-weight:700;color:var(--accent)}
.receipt .ref{display:block;font-size:22px;line-height:28px;font-weight:700;letter-spacing:-.01em;color:#0a0b0f}
.pill{align-self:flex-start;padding:2px 8px;font-size:12px;line-height:20px;font-weight:700;color:#5b6170;background:#eef0f4;border-radius:6px}
.receipt .pill{align-self:center;padding:0;color:var(--accent);background:none}
.pill.ok{color:#17803d;background:#e6f4ec}
.pill.no{color:#b42318;background:#fce9e9}
.lead{color:#3a3f4b}
.slots{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;border:0;min-width:0}
.slots legend{padding:0;font-size:12px;line-height:16px;font-weight:600;color:#3a3f4b}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.slots[hidden]{display:none}
.chips button{min-height:0;padding:6px 12px;font:inherit;font-size:13px;font-weight:600;line-height:18px;color:#0a0b0f;background:#fff;border:1px solid #d5d9e2;border-radius:6px;cursor:pointer}
.chips button[aria-pressed=true]{color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,#fff);border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.chips button:disabled{color:#7a808e;background:#eef0f4;text-decoration:line-through;cursor:not-allowed}
.wrap{width:min(480px,100%);display:flex;flex-direction:column;align-items:center;gap:18px}
.wrap main{width:100%;padding:32px;gap:16px}
.brandbar{display:flex;align-items:center;gap:10px;font-size:16px;line-height:24px;font-weight:700}
.brandbar img,.brandbar svg{display:block;width:30px;height:30px;border-radius:8px}
.eyebrow{font-size:11px;line-height:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5b6170}
.short h1{padding-bottom:10px;background:linear-gradient(var(--accent),var(--accent)) left bottom/40px 3px no-repeat}
.muted{font-size:12px;line-height:16px;color:#5b6170}
.msg{padding:14px 16px;white-space:pre-wrap;background:#f5f6f8;border:1px solid #e3e6ec;border-radius:8px}
.actions{flex-direction:row;gap:12px}
.wrap .btn{padding:10px 16px;border-radius:8px}
a.btn{display:inline-block;color:var(--on)}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
@media(max-width:560px){main,.wrap main{padding:20px}.row{flex-direction:column}form>.btn{align-self:stretch}}
@media(prefers-reduced-motion:reduce){main{animation:none}.btn{transition:none}}`;

const brandVars = (brand: PageBrand | undefined, fallback: { accent: string; ink: string }) => {
  const accent = safeColour(brand?.accent, fallback.accent);
  const ink = brand?.accent ? safeColour(brand.ink, "#ffffff") : fallback.ink;
  return `<style>:root{--accent:${accent};--on:${ink}}${CSS}</style>`;
};

const head = (title: string, brand: PageBrand | undefined, fallback: { accent: string; ink: string }) =>
  `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${brandVars(brand, fallback)}`;

const logo = (b: PageBrand) => `<img src="/brand/logo/${b.id}" alt="${escapeHtml(b.name ?? "")}">`;

export type ShellOptions = { body: string; title: string; language: Language; brand?: PageBrand; embed?: boolean };

/** A form, receipt or notice card on the neutral page. embed drops the page background so the host site shows around it. */
export function shell({ body, title, language, brand, embed }: ShellOptions) {
  const header = brand?.logo ? `<header>${logo(brand)}</header>` : "";
  return `<!doctype html><html lang="${language}"><head>${head(title, brand, { accent: "#0a0b0f", ink: "#ffffff" })}</head><body${embed ? ' class="embed"' : ""}><main${brand?.accent ? ' class="ruled"' : ""}>${header}${body}</main></body></html>`;
}

const MARK = `<svg viewBox="0 0 30 30" role="img" aria-label="Daloy"><rect width="30" height="30" rx="8" fill="#1b45c9"/><path d="M8 18.5 15 12l7 6.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export type ApprovalOptions = { title: string; heading?: string; body: string; language: Language; brand?: PageBrand; eyebrow?: string };

/**
 * The approval card. Branded, the business logo and name sit above it and the heading has a short accent rule;
 * with no brand it is the Daloy mark and an "Approval" label. Only the approval's own workspace brand is ever passed in.
 */
export function approvalShell({ title, heading, body, language, brand, eyebrow }: ApprovalOptions) {
  const named = brand && (brand.logo || brand.name) ? brand : undefined;
  const bar = named ? `${named.logo ? logo(named) : ""}${named.name ? `<span>${escapeHtml(named.name)}</span>` : ""}` : `${MARK}<span>Daloy</span>`;
  const label = !named && eyebrow ? `<p class="eyebrow">${escapeHtml(eyebrow)}</p>` : "";
  return `<!doctype html><html lang="${language}"><head>${head(title, brand, { accent: "#1b45c9", ink: "#ffffff" })}</head><body><div class="wrap"><div class="brandbar">${bar}</div><main${named ? ' class="short"' : ""}>${label}${heading ? `<h1>${heading}</h1>` : ""}${body}</main></div></body></html>`;
}

/**
 * Fills the open times under the date and time field of a booking form (served at /public/slots.js, so the page's
 * script-src 'self' holds). Without it the form still works: the visitor types a time and the server checks it.
 */
export const SLOTS_JS = `(function(){
var box=document.querySelector("[data-slots]");if(!box)return;
var res=document.getElementById(box.getAttribute("data-resource")),dt=document.getElementById(box.getAttribute("data-field")),list=box.querySelector(".chips"),legend=box.querySelector("legend"),last="",seq=0;
if(!res||!dt)return;
function mark(){var v=dt.value.slice(0,16);Array.prototype.forEach.call(list.children,function(b){b.setAttribute("aria-pressed",String(!b.disabled&&b.getAttribute("data-value")===v))})}
function show(d){legend.textContent=d.title;list.textContent="";
if(!d.slots.length){var p=document.createElement("span");p.className="hint";p.textContent=d.empty;list.appendChild(p)}
d.slots.forEach(function(s){var b=document.createElement("button");b.type="button";b.textContent=s.label;b.disabled=s.taken;b.setAttribute("data-value",s.value);
b.addEventListener("click",function(){dt.value=s.value;mark()});list.appendChild(b)});mark()}
function load(){var date=dt.value.slice(0,10);
if(!res.value||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)){box.hidden=true;last="";return}
var key=res.value+date;if(key===last){mark();return}last=key;var n=++seq;
fetch(box.getAttribute("data-url")+"?resource="+encodeURIComponent(res.value)+"&date="+date+"&field="+encodeURIComponent(dt.name),{headers:{Accept:"application/json"}})
.then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){if(n===seq){show(d);box.hidden=false}}).catch(function(){box.hidden=true})}
res.addEventListener("change",load);dt.addEventListener("change",load);dt.addEventListener("input",load);load()})();
`;
