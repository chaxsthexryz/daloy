import "./workspace.css";
import "./knowledge.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { KnowledgeEntry, KnowledgeKind, PriceUnit } from "@daloy/engine";
import { api } from "./api";
import { useLanguage } from "./Language";
import { emptyForm, emptyRule, hasStayTimes, isPriced, KNOWLEDGE_KINDS, PRICE_UNITS, summaryOf, toForm, toInput, WEEKDAYS, type EntryForm, type RuleForm } from "./lib/knowledge";

type State = {
  entries: KnowledgeEntry[];
  published: { version: number; createdAt: string; entryCount: number } | null;
  changed: boolean;
};

// The English words, looked up through t() where they show. One place so the form, the list and the tests agree on them.
const KIND_NAMES: Record<KnowledgeKind, string> = {
  room: "Room", rate: "Rate", fee: "Fee", faq: "FAQ", policy: "Policy", location: "Location", activity: "Activity", arrival: "Arrival", review_link: "Review link",
};
const UNIT_NAMES: Record<PriceUnit, string> = {
  night: "per night", person: "per person", person_night: "per person per night", stay: "per stay", day: "per day",
};
const DAY_NAMES: Record<(typeof WEEKDAYS)[number], string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/**
 * The knowledge sheet (decision 0116): what the resort wants the concierge to know. Entries are drafts until Publish
 * saves a numbered copy; guests only ever get answers from the published copy. Owner and operator.
 */
export function KnowledgePage() {
  const { t } = useLanguage();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // null: no form open; "new": a blank one; an entry: editing it.
  const [editing, setEditing] = useState<KnowledgeEntry | "new" | null>(null);
  const latest = useRef(0);
  const load = () => {
    const n = ++latest.current;
    return api<State>("GET", "/knowledge").then(
      (s) => n === latest.current && setState(s),
      (e: Error) => setError(e.message),
    );
  };
  useEffect(() => {
    load();
  }, []);
  const run = async (action: () => Promise<unknown>, done = "") => {
    setError("");
    setNotice("");
    try {
      await action();
      await load();
      setNotice(done);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const words = { per: (u: PriceUnit) => t(UNIT_NAMES[u]), rules: (n: number) => t("{count} named rules", { count: n }) };
  const publish = () => run(() => api("POST", "/knowledge/publish"), t("Published. The concierge now answers from this version."));
  const remove = (e: KnowledgeEntry) => {
    if (!window.confirm(t("Delete {title}? Guests keep getting the published version until you publish again.", { title: `"${e.title}"` }))) return;
    return run(() => api("DELETE", `/knowledge/entries/${e.id}`));
  };

  return (
    <main className="page wk kn">
      <header className="wk-head">
        <div>
          <div className="wk-title-row">
            <h1>{t("Knowledge")}</h1>
            {state && <span className="wk-sub">{t("{count} entries", { count: state.entries.length })}</span>}
          </div>
        </div>
      </header>
      <p className="wk-lead">{t("Write what guests ask about: rooms, rates, policies, questions and links. The concierge answers only from the published version, so check prices before you publish.")}</p>
      {state && (
        <section className="wk-card wk-body kn-publish" aria-labelledby="kn-status">
          <div>
            <h2 id="kn-status" className="wk-card-title">
              {state.published ? t("Live: version {version}", { version: state.published.version }) : t("Not published yet")}
            </h2>
            <p className="wk-sub">
              {state.published
                ? t("Published {date}, {count} entries.", { date: new Date(state.published.createdAt).toLocaleString(), count: state.published.entryCount })
                : t("The concierge has nothing to answer from until you publish.")}
              {" "}
              {state.changed ? <strong>{t("You have changes that are not published.")}</strong> : state.published ? t("No changes since then.") : ""}
            </p>
          </div>
          <button type="button" className="wk-button blue" disabled={!state.changed} onClick={publish}>{t("Publish")}</button>
        </section>
      )}
      <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
      <p role="status" className="wk-note" hidden={!notice}>{notice}</p>
      {editing ? (
        <EntryForm
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? emptyForm() : toForm(editing)}
          onCancel={() => setEditing(null)}
          onSave={async (form) => {
            const body = toInput(form);
            if (editing === "new") await api("POST", "/knowledge/entries", body);
            else await api("PATCH", `/knowledge/entries/${editing.id}`, body);
            setEditing(null);
            setNotice("");
            await load();
          }}
        />
      ) : (
        <p><button type="button" className="wk-button blue" onClick={() => setEditing("new")}>{t("Add an entry")}</button></p>
      )}
      {state === null ? (
        <p className="wk-sub" role="status">{t("Loading…")}</p>
      ) : state.entries.length === 0 ? (
        <p className="wk-sub">{t("No entries yet. Start with your rooms and your rates.")}</p>
      ) : (
        <ul className="wk-card kn-list">
          {state.entries.map((e) => (
            <li key={e.id}>
              <div className="kn-main">
                <span className="wk-pill">{t(KIND_NAMES[e.kind])}</span>
                <strong className="wk-name">{e.title}</strong>
                <span className="wk-sub kn-summary">{summaryOf(e, words)}</span>
              </div>
              <div className="wk-acts">
                <button type="button" className="wk-button" aria-label={t("Edit {title}", { title: e.title })} onClick={() => setEditing(e)}>{t("Edit")}</button>
                <button type="button" className="wk-button" aria-label={t("Delete {title}", { title: e.title })} onClick={() => remove(e)}>{t("Delete")}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function EntryForm({ initial, onSave, onCancel }: { initial: EntryForm; onSave: (form: EntryForm) => Promise<void>; onCancel: () => void }) {
  const { t } = useLanguage();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof EntryForm>(key: K, value: EntryForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setRule = (i: number, patch: Partial<RuleForm>) => set("rules", form.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const priced = isPriced(form.kind);
  const stayTimes = hasStayTimes(form.kind);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(form);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="wk-card wk-body wk-fields kn-form" aria-labelledby="kn-form-title">
      <h2 id="kn-form-title" className="wk-card-title">{initial.title ? t("Edit entry") : t("New entry")}</h2>
      <div>
        <label htmlFor="kn-kind">{t("Kind")}</label>
        <select id="kn-kind" value={form.kind} onChange={(e) => set("kind", e.target.value as KnowledgeKind)}>
          {KNOWLEDGE_KINDS.map((k) => <option key={k} value={k}>{t(KIND_NAMES[k])}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="kn-title">{t("Title")}</label>
        <input id="kn-title" type="text" value={form.title} onChange={(e) => set("title", e.target.value)} required maxLength={120} />
      </div>
      <div>
        <label htmlFor="kn-body">{t("Text")} <span className="wk-muted">{t("(what the concierge may say)")}</span></label>
        <textarea id="kn-body" rows={4} value={form.body} onChange={(e) => set("body", e.target.value)} maxLength={2000} />
      </div>
      {priced && (
        <fieldset className="kn-price">
          <legend>{t("Price")}</legend>
          <div className="kn-row">
            <div>
              <label htmlFor="kn-price">{t("Base price (PHP)")}</label>
              <input id="kn-price" type="number" inputMode="numeric" min={0} step={1} value={form.price} onChange={(e) => set("price", e.target.value)} />
            </div>
            <div>
              <label htmlFor="kn-unit">{t("Charged")}</label>
              <select id="kn-unit" value={form.unit} onChange={(e) => set("unit", e.target.value as EntryForm["unit"])}>
                <option value="">{t("Not stated")}</option>
                {PRICE_UNITS.map((u) => <option key={u} value={u}>{t(UNIT_NAMES[u])}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="kn-capacity">{t("Sleeps")}</label>
              <input id="kn-capacity" type="number" inputMode="numeric" min={1} step={1} value={form.capacity} onChange={(e) => set("capacity", e.target.value)} />
            </div>
          </div>
          <div className="kn-row">
            <div>
              <label htmlFor="kn-deposit">{t("Deposit")}</label>
              <select id="kn-deposit" value={form.deposit} onChange={(e) => set("deposit", e.target.value as EntryForm["deposit"])}>
                <option value="">{t("Not stated")}</option>
                <option value="fixed">{t("Fixed amount (PHP)")}</option>
                <option value="percent">{t("Percent of the total")}</option>
              </select>
            </div>
            {form.deposit && (
              <div>
                <label htmlFor="kn-deposit-value">{form.deposit === "percent" ? t("Deposit percent") : t("Deposit amount (PHP)")}</label>
                <input id="kn-deposit-value" type="number" inputMode="numeric" min={form.deposit === "percent" ? 1 : 0} max={form.deposit === "percent" ? 100 : undefined} step={1} value={form.depositValue} onChange={(e) => set("depositValue", e.target.value)} required />
              </div>
            )}
          </div>
          <h3 className="kn-sub">{t("Named rules")}</h3>
          <p className="wk-muted">{t("Seasons, weekday rates or extra-guest fees. A season is two dates as MM-DD, such as 12-15 to 01-10. Leave the dates empty for a rule that always applies.")}</p>
          {form.rules.map((r, i) => (
            <div key={i} className="kn-rule">
              <div className="kn-row">
                <div>
                  <label htmlFor={`kn-rule-name-${i}`}>{t("Rule name")}</label>
                  <input id={`kn-rule-name-${i}`} type="text" value={r.name} onChange={(e) => setRule(i, { name: e.target.value })} required maxLength={60} />
                </div>
                <div>
                  <label htmlFor={`kn-rule-price-${i}`}>{t("Price (PHP)")}</label>
                  <input id={`kn-rule-price-${i}`} type="number" inputMode="numeric" min={0} step={1} value={r.price} onChange={(e) => setRule(i, { price: e.target.value })} required />
                </div>
                <div>
                  <label htmlFor={`kn-rule-unit-${i}`}>{t("Charged")}</label>
                  <select id={`kn-rule-unit-${i}`} value={r.unit} onChange={(e) => setRule(i, { unit: e.target.value as RuleForm["unit"] })}>
                    <option value="">{t("Same as the base price")}</option>
                    {PRICE_UNITS.map((u) => <option key={u} value={u}>{t(UNIT_NAMES[u])}</option>)}
                  </select>
                </div>
              </div>
              <div className="kn-row">
                <div>
                  <label htmlFor={`kn-rule-from-${i}`}>{t("From (MM-DD)")}</label>
                  <input id={`kn-rule-from-${i}`} type="text" inputMode="numeric" placeholder="12-15" pattern="\d\d-\d\d" value={r.from} onChange={(e) => setRule(i, { from: e.target.value })} />
                </div>
                <div>
                  <label htmlFor={`kn-rule-to-${i}`}>{t("To (MM-DD)")}</label>
                  <input id={`kn-rule-to-${i}`} type="text" inputMode="numeric" placeholder="01-10" pattern="\d\d-\d\d" value={r.to} onChange={(e) => setRule(i, { to: e.target.value })} />
                </div>
              </div>
              <fieldset className="kn-days">
                <legend>{t("Only on these days")}</legend>
                {WEEKDAYS.map((d) => (
                  <label key={d} className="kn-day">
                    <input type="checkbox" checked={r.days.includes(d)} onChange={(e) => setRule(i, { days: e.target.checked ? [...r.days, d] : r.days.filter((x) => x !== d) })} />
                    {t(DAY_NAMES[d])}
                  </label>
                ))}
              </fieldset>
              <button type="button" className="wk-button" onClick={() => set("rules", form.rules.filter((_, j) => j !== i))}>{t("Remove rule")}</button>
            </div>
          ))}
          {form.rules.length < 12 && <button type="button" className="wk-button" onClick={() => set("rules", [...form.rules, emptyRule()])}>{t("Add a rule")}</button>}
        </fieldset>
      )}
      {stayTimes && (
        <fieldset className="kn-price">
          <legend>{t("Stay hours")}</legend>
          <div className="kn-row">
            <div>
              <label htmlFor="kn-check-in">{t("Check-in time")}</label>
              <input id="kn-check-in" type="time" value={form.checkInTime} onChange={(e) => set("checkInTime", e.target.value)} />
            </div>
            <div>
              <label htmlFor="kn-check-out">{t("Check-out time")}</label>
              <input id="kn-check-out" type="time" value={form.checkOutTime} onChange={(e) => set("checkOutTime", e.target.value)} />
            </div>
          </div>
        </fieldset>
      )}
      <div>
        <label htmlFor="kn-url">{t("Link")} <span className="wk-muted">{t("(optional, https only)")}</span></label>
        <input id="kn-url" type="url" value={form.url} onChange={(e) => set("url", e.target.value)} maxLength={500} placeholder="https://" />
      </div>
      <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
      <div className="kn-actions">
        <button className="wk-button blue" disabled={busy}>{t("Save entry")}</button>
        <button type="button" className="wk-button" onClick={onCancel}>{t("Cancel")}</button>
      </div>
    </form>
  );
}
