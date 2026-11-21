import "./workspace.css";
import "./onboarding.css";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BUSINESS_CATEGORIES, needsPayment, ONBOARDING_GOALS, ONBOARDING_PAYMENTS, suggestedGoal, type BusinessCategory, type OnboardingGoal, type OnboardingPayment } from "@daloy/engine";
import { api, type Workflow } from "./api";
import { useLanguage } from "./Language";
import { answersFrom, canContinue, initials, toggleRelated, withPrimary, type Answers, type OnboardingState } from "./lib/onboarding";

type View = 1 | 2 | 3 | "done";
const LOGO_MAX = 100 * 1024;

// Source strings are literals so the Tagalog table in lib/locale-onboarding.ts can match them.
const STEP_NAMES = ["Your business", "Business type", "First workflow"] as const;
const CATEGORY: Record<BusinessCategory, [string, string]> = {
  online_retail: ["Online retail", "You sell products through a page, a shop or chat."],
  food_orders: ["Food orders", "You take orders for food or drinks."],
  beauty_wellness: ["Beauty and wellness", "Salon, spa, clinic or fitness bookings."],
  professional_services: ["Professional services", "Clients book you or ask for quotes."],
  other: ["Other", "Something else. You can change this later."],
};
const GOAL: Record<OnboardingGoal, [string, string]> = {
  receipt_review: ["Receipt review", "Customers send a payment receipt and you check it against the order."],
  bookings: ["Bookings", "Customers ask for a time and you confirm it."],
  order_follow_up: ["Order follow-up", "Each new order is logged, the customer is told, and you see what needs attention."],
};
const PAYMENT: Record<OnboardingPayment, [string, string]> = {
  manual_qrph: ["Manual QR Ph transfer", "Customers pay to your QR Ph code and send the receipt. You review it."],
  gcash_paymongo: ["GCash checkout through PayMongo", "Customers pay on a checkout page and Daloy gets the result."],
  pay_later: ["Pay later", "No payment is asked for in this workflow."],
};
const ICON: Record<string, string> = {
  online_retail: "M6 7h12l1 13H5L6 7zM9 7a3 3 0 0 1 6 0",
  food_orders: "M4 11h16a8 8 0 0 1-16 0zM8 4c0 1.5 1 1.5 1 3M12 4c0 1.5 1 1.5 1 3",
  beauty_wellness: "M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z",
  professional_services: "M4 8h16v11H4zM9 8V5h6v3M4 13h16",
  other: "M5 12h.01M12 12h.01M19 12h.01",
  receipt_review: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  bookings: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  order_follow_up: "M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8",
  manual_qrph: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2z",
  gcash_paymongo: "M3 6h18v12H3zM3 10h18M7 15h4",
  pay_later: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2",
};
const Icon = ({ name }: { name: string }) => (
  <svg className="ob-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d={ICON[name]} />
  </svg>
);

/** On a phone the on-screen keyboard shrinks the visual viewport; --ob-kb lifts the action bar above it. */
function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty("--ob-kb", `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--ob-kb");
    };
  }, []);
}

/** #/onboarding: three screens, one question each, saved after every screen (roadmap R1, decision 0082). */
export function OnboardingPage() {
  const { t } = useLanguage();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [answers, setAnswers] = useState<Answers | null>(null);
  const [view, setView] = useState<View>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [logo, setLogo] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useKeyboardInset();

  const load = () =>
    api<OnboardingState>("GET", "/onboarding").then(
      (s) => {
        setState(s);
        setAnswers(answersFrom(s));
        setLogo(s.identity.logoUrl);
        setView(s.status === "completed" && s.workflowId ? "done" : s.step);
      },
      () => setLoadError(true),
    );
  useEffect(() => void load(), []);
  // A new screen starts at its question, for keyboard and screen reader users too.
  useEffect(() => heading.current?.focus(), [view, !!state]);

  if (loadError) return <main className="page wk ob"><p role="alert" className="wk-bad">{t("Couldn't load your setup.")} <button type="button" className="wk-button" onClick={() => { setLoadError(false); void load(); }}>{t("Retry")}</button></p></main>;
  if (!state || !answers) return <main className="page wk ob"><p className="wk-muted">{t("Loading…")}</p></main>;

  const set = (patch: Partial<Answers>) => setAnswers({ ...answers, ...patch });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  /** Saves the answers of one screen. Nothing else happens: no connection, no message, no publish. */
  const saveScreen = (screen: 1 | 2 | 3) => {
    if (screen === 1) return api("PUT", "/onboarding/identity", { businessName: answers.name, website: answers.website });
    if (screen === 2) return api("PUT", "/onboarding/type", { primary: answers.primary, related: answers.related });
    return api("PUT", "/onboarding/workflow", { goal: answers.goal, ...(answers.goal && needsPayment(answers.goal) ? { payment: answers.payment } : {}) });
  };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const next = (e: FormEvent) => {
    e.preventDefault();
    if (view === "done" || !canContinue(view, answers)) return;
    const screen = view;
    void run(async () => {
      await saveScreen(screen);
      if (screen === 2 && !answers.goal) set({ goal: suggestedGoal(answers.primary) });
      if (screen < 3) return setView((screen + 1) as 2 | 3);
      await api("POST", "/onboarding/finish");
      await load();
    });
  };
  const saveAndClose = () =>
    void run(async () => {
      if (view !== "done" && canContinue(view, answers)) await saveScreen(view);
      location.hash = "#/";
    });
  const chooseLogo = (file: File | undefined) => {
    if (!file) return;
    if (file.size > LOGO_MAX) return setError(t("The logo is over 100 KB. Choose a smaller PNG, JPEG or WebP file."));
    void run(async () => {
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(t("The file could not be read.")));
        reader.readAsDataURL(file);
      });
      await api("PUT", "/settings/brand/logo", { data: url.slice(url.indexOf(",") + 1) });
      setLogo(url);
    });
  };
  const removeLogo = () => void run(async () => { await api("DELETE", "/settings/brand/logo"); setLogo(null); });

  if (view === "done") return <DoneView state={state} headingRef={heading} onEdit={() => { setError(""); setView(1); }} />;

  const stepName = t(STEP_NAMES[view - 1]!);
  const stepText = t("Step {n} of 3: {name}", { n: view, name: stepName });
  const goal = answers.goal;
  return (
    <main className="page wk ob motion-page">
      <header className="ob-head">
        <p className="ob-brand">{t("Set up Daloy")}</p>
        <button type="button" className="wk-button" disabled={busy} onClick={saveAndClose}>{t("Save and close")}</button>
      </header>
      <div className="ob-progress" role="progressbar" aria-label={t("Setup progress")} aria-valuemin={1} aria-valuemax={3} aria-valuenow={view} aria-valuetext={stepText}>
        {[1, 2, 3].map((n) => <span key={n} data-on={n <= view || undefined} />)}
      </div>
      <p className="ob-step">{stepText}</p>

      <form className="ob-form" onSubmit={next} noValidate>
        {view === 1 && (
          <>
            <h1 ref={heading} tabIndex={-1}>{t("What name should customers see?")}</h1>
            <p className="wk-muted">{t("It appears in your messages and on your public forms. You can change it in Business settings.")}</p>
            <div className="wk-fields">
              <div>
                <label htmlFor="ob-name">{t("Business name")}</label>
                <input id="ob-name" value={answers.name} maxLength={120} autoComplete="organization" required onChange={(e) => set({ name: e.target.value })} />
              </div>
              <div>
                <label htmlFor="ob-site">{t("Website")} <span className="wk-muted">{t("(optional)")}</span></label>
                <input id="ob-site" type="url" inputMode="url" placeholder="https://" value={answers.website} maxLength={500} autoComplete="url" onChange={(e) => set({ website: e.target.value })} />
              </div>
              <div className="ob-logo">
                <span className="ob-mark" aria-hidden="true">{logo ? <img src={logo} alt="" /> : initials(answers.name)}</span>
                <div>
                  <label htmlFor="ob-logo">{t("Logo")} <span className="wk-muted">{t("(optional)")}</span></label>
                  <input id="ob-logo" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(e) => { chooseLogo(e.target.files?.[0]); e.target.value = ""; }} />
                  <p className="wk-muted">{logo ? t("Your logo is saved.") : t("Your initials show until you add a logo. PNG, JPEG or WebP, up to 100 KB.")}</p>
                  {logo && <button type="button" className="wk-button" disabled={busy} onClick={removeLogo}>{t("Remove logo")}</button>}
                </div>
              </div>
            </div>
          </>
        )}

        {view === 2 && (
          <>
            <h1 ref={heading} tabIndex={-1}>{t("What kind of business do you run?")}</h1>
            <fieldset className="ob-set">
              <legend>{t("Main type")}</legend>
              <div className="ob-cards">
                {BUSINESS_CATEGORIES.map((c) => (
                  <Choice key={c} type="radio" name="primary" icon={c} title={t(CATEGORY[c][0])} note={t(CATEGORY[c][1])} checked={answers.primary === c} onChange={() => setAnswers(withPrimary(answers, c))} />
                ))}
              </div>
            </fieldset>
            {answers.primary && (
              <fieldset className="ob-set">
                <legend>{t("Anything else you also do? Pick up to three.")}</legend>
                <div className="ob-cards">
                  {BUSINESS_CATEGORIES.filter((c) => c !== answers.primary).map((c) => (
                    <Choice key={c} type="checkbox" name="related" icon={c} title={t(CATEGORY[c][0])} checked={answers.related.includes(c)} disabled={!answers.related.includes(c) && answers.related.length >= 3} onChange={() => set({ related: toggleRelated(answers.related, c) })} />
                  ))}
                </div>
              </fieldset>
            )}
          </>
        )}

        {view === 3 && (
          <>
            <h1 ref={heading} tabIndex={-1}>{t("What would you like Daloy to handle first?")}</h1>
            <fieldset className="ob-set">
              <legend>{t("First workflow")}</legend>
              <div className="ob-cards">
                {ONBOARDING_GOALS.map((g) => (
                  <Choice key={g} type="radio" name="goal" icon={g} title={t(GOAL[g][0])} note={t(GOAL[g][1])} tag={answers.primary && g === suggestedGoal(answers.primary) ? t("Suggested") : undefined} checked={goal === g} onChange={() => set({ goal: g, payment: needsPayment(g) ? answers.payment : null })} />
                ))}
              </div>
            </fieldset>
            {goal && needsPayment(goal) && (
              <fieldset className="ob-set">
                <legend>{t("How do customers pay?")}</legend>
                <div className="ob-cards">
                  {ONBOARDING_PAYMENTS.map((p) => (
                    <Choice key={p} type="radio" name="payment" icon={p} title={t(PAYMENT[p][0])} note={t(PAYMENT[p][1])} checked={answers.payment === p} onChange={() => set({ payment: p })} />
                  ))}
                </div>
              </fieldset>
            )}
            <p className="ob-safe">{t("Daloy makes a draft you can edit and test. Nothing is connected, published or sent until you do it.")}</p>
          </>
        )}

        <p role="alert" className="wk-bad ob-error" hidden={!error}>{error}</p>
        <div className="ob-bar">
          {view > 1 && <button type="button" className="wk-button" disabled={busy} onClick={() => { setError(""); setView((view - 1) as 1 | 2); }}>{t("Back")}</button>}
          <button type="submit" className="wk-button blue" disabled={busy || !canContinue(view, answers)}>{view === 3 ? t("Create my draft") : t("Next")}</button>
        </div>
      </form>
    </main>
  );
}

function Choice({ type, name, icon, title, note, tag, checked, disabled, onChange }: { type: "radio" | "checkbox"; name: string; icon: string; title: string; note?: string; tag?: string; checked: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <label className="ob-card" data-disabled={disabled || undefined}>
      <input type={type} name={name} checked={checked} disabled={disabled} onChange={onChange} />
      <Icon name={icon} />
      <span className="ob-card-text">
        <b>{title}{tag && <span className="wk-chip">{tag}</span>}</b>
        {note && <small>{note}</small>}
      </span>
    </label>
  );
}

function DoneView({ state, headingRef, onEdit }: { state: OnboardingState; headingRef: React.RefObject<HTMLHeadingElement | null>; onEdit: () => void }) {
  const { t } = useLanguage();
  const [name, setName] = useState("");
  useEffect(() => void api<Workflow>("GET", `/workflows/${state.workflowId}`).then((w) => setName(w.name), () => undefined), [state.workflowId]);
  const sample = Object.entries(state.sample ?? {});
  return (
    <main className="page wk ob motion-page">
      <header className="ob-head">
        <p className="ob-brand">{t("Set up Daloy")}</p>
        <a className="wk-button" href="#/">{t("Close")}</a>
      </header>
      <p className="ob-step">{t("Step {n} of 3: {name}", { n: 3, name: t("First workflow") })}. {t("Done")}</p>
      <div className="ob-form">
        <h1 ref={headingRef} tabIndex={-1}>{t("Your draft is ready")}</h1>
        <p className="wk-muted">{t("Daloy made one draft from the closest template. Open it to change any step and run a test with the sample order.")}</p>
        <section className="wk-card" aria-label={t("Draft")}>
          <div className="wk-card-head"><b>{name || t("Your first workflow")}</b><span>{t("Draft, not turned on")}</span></div>
          <div className="wk-body">
            <h2 className="wk-card-title">{t("Sample order")}</h2>
            <dl className="ob-sample">
              {sample.map(([k, v]) => <div key={k}><dt>{k.replaceAll("_", " ")}</dt><dd>{String(v)}</dd></div>)}
            </dl>
          </div>
        </section>
        <p className="ob-safe">{t("Nothing is connected, published or sent yet. Connect your apps and turn the workflow on when you are ready.")}</p>
        <div className="ob-bar">
          <button type="button" className="wk-button" onClick={onEdit}>{t("Edit my answers")}</button>
          <a className="wk-button blue" href={`#/w/${state.workflowId}`}>{t("Open my draft")}</a>
        </div>
      </div>
    </main>
  );
}

/** The card at the top of Automations: Start setup for a new owner, Resume setup after Save and close. */
export function OnboardingPrompt() {
  const { t } = useLanguage();
  const [state, setState] = useState<OnboardingState | null>(null);
  useEffect(() => void api<OnboardingState>("GET", "/onboarding").then(setState, () => undefined), []);
  if (!state || (state.status !== "not_started" && state.status !== "in_progress")) return null;
  const resuming = state.status === "in_progress";
  const dismiss = () => api("POST", "/onboarding/dismiss").then(() => setState({ ...state, status: "dismissed" }), () => undefined);
  const text: ReactNode = resuming ? t("Step {n} of 3: {name}", { n: state.step, name: t(STEP_NAMES[state.step - 1]!) }) : t("Three short questions, and Daloy makes a first draft you can test.");
  return (
    <aside className="ob-prompt" aria-label={t("Setup")}>
      <div>
        <b>{resuming ? t("Finish setting up your business") : t("Set up your business")}</b>
        <p>{text}</p>
      </div>
      <a className="wk-button blue" href="#/onboarding">{resuming ? t("Resume setup") : t("Start setup")}</a>
      <button type="button" className="wk-button" onClick={() => void dismiss()}>{t("Not now")}</button>
    </aside>
  );
}
