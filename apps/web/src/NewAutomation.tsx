import "./automations-ops.css";
import "./guided-pages.css";
import "./library.css";
import {
  defaultAnswers,
  defaultPurchaseAnswers,
  explainFlow,
  markText,
  officeRequestDefinition,
  purchaseRequestDefinition,
  stepEntry,
  TEMPLATE_CATEGORIES,
  templatesForLanguage,
  triggerEntry,
  websiteInquiryDefinition,
  type TemplateCategory,
  type TemplateReadiness,
  type TemplateStyle,
  type WorkflowDefinition,
} from "@daloy/engine";
import { Text, useLanguage } from "./Language";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, ApiError, getTemplatesReadiness, type Workflow } from "./api";
import { AppMark } from "./AppMark";
import { BuildWithAiPage } from "./BuildWithAi";
import { RunFlow } from "./FlowCanvas";
import { startOfficeSetup, startPurchaseSetup } from "./OfficeRequests";
import { Sheet, usePhone } from "./Sheet";
import { pushToast } from "./Toast";
import { taglishSampleFor } from "./lib/library";
import type { Language } from "./lib/locale";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

/** One ready-made workflow in the library. `go` starts it; `href` is for a start that lives on another page. */
type Card = { key: string; category: TemplateCategory; name: string; description: string; definition: WorkflowDefinition; template?: string; go?: () => void; href?: string; label?: string; sample?: string };

/** The apps a workflow needs, once each, from the step catalog. A step kymavo does itself needs no app. */
function appsOf(def: WorkflowDefinition, language: Language) {
  const entries = [triggerEntry(def.trigger.type), ...def.steps.map((s) => stepEntry(s.type))].filter((e) => e.app);
  return [...new Map(entries.map((e) => [e.mark, markText(e, language)])).entries()].map(([mark, name]) => ({ mark, name }));
}

/** #/new and #/ai: unified New automation picker with Templates and Build with AI tabs (decision 0147). */
export function NewAutomationPage({
  email,
  initialMode = "templates",
  admin = false,
}: {
  email: string;
  initialMode?: "templates" | "ai";
  admin?: boolean;
}) {
  const { language, t } = useLanguage();
  const mode = initialMode;
  const phone = usePhone();
  const [style, setStyle] = useState<TemplateStyle>("default");
  const templates = templatesForLanguage(language, style);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<TemplateCategory | "All">("All");
  const [selected, setSelected] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState("");
  const [error, setError] = useState("");
  // One start or create at a time: a repeated click must not make a second draft.
  const [busy, setBusy] = useState(false);
  const [readinessBySlug, setReadinessBySlug] = useState<Record<string, TemplateReadiness>>({});
  const dialog = useRef<HTMLDivElement>(null);
  const lastTriggerKey = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const loadReadiness = () => {
      void getTemplatesReadiness().then(
        (list) => {
          if (active) setReadinessBySlug(Object.fromEntries(list.map((r) => [r.slug, r])));
        },
        () => undefined,
      );
    };
    loadReadiness();
    window.addEventListener("focus", loadReadiness);
    return () => {
      active = false;
      window.removeEventListener("focus", loadReadiness);
    };
  }, [language]);

  const start = (go: (email: string, language: Language) => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    go(email, language).catch((e: Error) => {
      setError(e.message);
      setBusy(false);
    });
  };

  /** Creates the draft: a blank one, or one filled from a template with the owner's address in place of the sample one. */
  const createDraft = async (slug: string, draftName: string, cardKey = slug) => {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const wf = await api<Workflow>("POST", "/workflows", { name: draftName, slug: slugify(draftName) || "workflow" });
      const item = templates.find((x) => x.slug === slug);
      if (item) {
        const ownerEmail = email.trim();
        const definition = ownerEmail
          ? {
              ...item.definition,
              steps: item.definition.steps.map((s) => {
                const cfg = s.config as Record<string, unknown>;
                const nextCfg = { ...cfg };
                if (nextCfg.to === "owner@example.com") nextCfg.to = ownerEmail;
                if (nextCfg.approver === "owner@example.com") nextCfg.approver = ownerEmail;
                return { ...s, config: nextCfg };
              }),
            }
          : item.definition;
        await api("POST", `/workflows/${wf.id}/versions`, { definition, publish: false });
        await api("PATCH", `/workflows/${wf.id}/setup`, { kind: "generated", template: slug, step: "questions", answers: {} });
      }
      pushToast({
        message: t(slug ? "Created draft from template." : "Created blank automation."),
        tone: "success",
      });
      location.hash = item ? `#/a/${wf.id}` : `#/w/${wf.id}`;
    } catch (err) {
      const taken = err instanceof ApiError && err.status === 409;
      setError(taken ? t("An automation with that name already exists.") : (err as Error).message);
      // A taken name can be changed in the preview, so open it.
      if (taken) open(cardKey, draftName);
      setBusy(false);
    }
  };

  const createBlank = (e: React.FormEvent) => {
    e.preventDefault();
    void createDraft("", name);
  };

  const cards: Card[] = [
    ...templates.map((item): Card => ({ key: item.slug, category: item.category, name: t(item.name), description: t(item.description), definition: item.definition as unknown as WorkflowDefinition, template: item.slug })),
    {
      key: "office",
      category: "Office",
      name: t("Track an office request"),
      description: t("Record requests and notify your office."),
      definition: officeRequestDefinition(defaultAnswers(email, language), language),
      go: () => start(startOfficeSetup),
      sample: "#/try/office-request",
      label: t("Set up for my office"),
    },
    {
      key: "purchase",
      category: "Office",
      name: t("Purchase request with approval"),
      description: t("Ask a reviewer before notifying purchasing."),
      definition: purchaseRequestDefinition(defaultPurchaseAnswers(email, language), language),
      go: () => start(startPurchaseSetup),
      label: t("Set up purchase requests"),
    },
    {
      key: "inquiry-site",
      category: "Inquiries",
      name: t("Reply to a website inquiry"),
      description: t("Reply to the sender and notify your team."),
      definition: websiteInquiryDefinition({ businessName: t("Your business"), inquiryEmail: email }, language),
      href: "#/business",
      label: t("Business setup: set up inquiry replies"),
    },
  ];
  // Card order follows the category chips, so a category reads as one group.
  const order = (c: Card) => TEMPLATE_CATEGORIES.indexOf(c.category);
  cards.sort((a, b) => order(a) - order(b));

  const q = query.trim().toLowerCase();
  const matches = (...text: string[]) => !q || text.some((x) => x.toLowerCase().includes(q));
  const shown = cards.filter((c) => (category === "All" || c.category === category) && matches(c.name, c.description, t(c.category)));
  const blankName = t("Blank automation");
  const blankText = t("Choose a trigger, then add and connect the steps in the editor.");
  const card = selected ? cards.find((c) => c.key === selected) : undefined;

  function open(key: string, defaultName?: string) {
    const c = cards.find((c) => c.key === key);
    lastTriggerKey.current = key;
    setSelected(key);
    setPreviewName(defaultName ?? c?.name ?? "");
  }
  const close = () => setSelected(null);
  useEffect(() => {
    if (card && !phone) {
      const frame = requestAnimationFrame(() => dialog.current?.focus());
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      };
      window.addEventListener("keydown", onKey);
      return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("keydown", onKey);
      };
    }
    if (!card && !phone && lastTriggerKey.current) {
      const key = lastTriggerKey.current;
      lastTriggerKey.current = null;
      requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>(`button.lib-open[data-preview-key="${CSS.escape(key)}"]`)?.focus();
      });
    }
  }, [card?.key, phone]);

  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    setDrawn(false);
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, [card?.key, phone]);

  const previewSample = card && style === "taglish" ? taglishSampleFor(card.definition) : null;
  const preview = card && (
    <section className="lib-preview" aria-labelledby={phone ? undefined : "lib-preview-title"}>
      <header>
        <div>
          <p className="gp-eyebrow">{t(card.category)}</p>
          {!phone && <h2 id="lib-preview-title">{card.name}</h2>}
        </div>
        {!phone && <button type="button" className="ops-button" onClick={close}><Text>Close</Text></button>}
      </header>
      <p className="gp-lead">{card.description}</p>
      {card.template && readinessBySlug[card.template] && !readinessBySlug[card.template]!.ready && (
        <div className="lib-readiness-box" role="status">
          <strong>{t("Needed before turning on")}</strong>
          <ul>
            {readinessBySlug[card.template]!.blockers.map((b) => (
              <li key={b.id}>{b.text}</li>
            ))}
          </ul>
        </div>
      )}
      {previewSample && (
        <div className="lib-sample">
          <h3><Text>Sample message</Text></h3>
          {previewSample.subject && <p className="lib-sample-subject">{previewSample.subject}</p>}
          <p>{previewSample.body}</p>
        </div>
      )}
      <div className="lib-preview-body">
        <div className="lib-diagram" role="group" aria-label={t("Diagram of {name}", { name: card.name })}>
          {/* Keyed so each card fits its own diagram; held one frame so a sheet is open (and has a size) before the diagram fits itself to it. */}
          {drawn && <RunFlow key={card.key + style} draft={card.definition} run={null} />}
        </div>
        <div className="lib-words">
          <h3><Text>Steps</Text></h3>
          <ul className="lib-steps">
            {explainFlow(card.definition, language).map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      </div>
      {card.template && (
        <div className="gp-field lib-name">
          <label htmlFor="lib-preview-name"><Text>Name</Text></label>
          <input id="lib-preview-name" value={previewName} onChange={(e) => setPreviewName(e.target.value)} maxLength={200} />
        </div>
      )}
      <p role="alert" className="gp-error" hidden={!error}>{error}</p>
      <div className="gp-actions">
        {card.template ? (
          <button type="button" className="ops-button blue" disabled={busy || !previewName.trim()} onClick={() => void createDraft(card.template!, previewName.trim(), card.key)}><Text>Use this</Text></button>
        ) : card.href ? (
          <a className="ops-button blue" href={card.href}><Text>Business setup</Text></a>
        ) : (
          <button type="button" className="ops-button blue" disabled={busy} onClick={card.go}><Text>Use this</Text></button>
        )}
      </div>
    </section>
  );

  const useButton = (c: Card) =>
    c.href ? (
      <a className="ops-button" href={c.href} aria-label={c.label}><Text>Business setup</Text></a>
    ) : (
      <button type="button" className="ops-button" disabled={busy} aria-label={t("Use this: {name}", { name: c.name })} onClick={() => (c.template ? void createDraft(c.template, c.name, c.key) : c.go?.())}>
        <Text>Use this</Text>
      </button>
    );

  const meta = (def: WorkflowDefinition, slug?: string) => {
    const apps = appsOf(def, language);
    const readiness = slug ? readinessBySlug[slug] : undefined;
    return (
      <>
        <p className="lib-line"><span><Text>Starts with</Text></span> {triggerEntry(def.trigger.type).action[language]}</p>
        <p className="lib-line lib-apps">
          <span><Text>Needs</Text></span>
          {apps.length
            ? apps.map((a) => (
                <span key={a.mark} className="lib-app-chip" title={a.name}>
                  <AppMark mark={a.mark} name={a.name} size={18} decorative />
                  <span>{a.name}</span>
                </span>
              ))
            : <em><Text>No apps needed</Text></em>}
        </p>
        {readiness && (
          <p className="lib-line lib-readiness-line">
            <span><Text>Setup</Text></span>
            {readiness.ready ? (
              <em className="lib-ready-ok">{t("Ready to turn on")}</em>
            ) : (
              <span className="lib-ready-needs">
                {readiness.blockers[0]!.text}
                {readiness.blockers.length > 1 ? ` (+${readiness.blockers.length - 1})` : ""}
              </span>
            )}
          </p>
        )}
      </>
    );
  };

  // The sidebar tree links Templates and Build with AI (decision 0164), so each is its own titled page.
  if (mode === "ai") {
    return (
      <main className="page ops gp lib motion-page">
        <header className="act-head">
          <div>
            <h1>{t("Build with AI")}</h1>
            <p className="act-sub">{t("Describe an automation in plain words and turn it into editable steps.")}</p>
          </div>
        </header>
        <BuildWithAiPage email={email} admin={admin} embedded />
      </main>
    );
  }

  return (
    <main className="page ops gp lib motion-page">
      <header className="act-head">
        <div>
          <h1>{t("Templates")}</h1>
          <p className="act-sub">{t("Choose the workflow closest to the way your team works.")}</p>
        </div>
        <div className="act-actions">
          <a className="act-button" href="#/ai">{t("Build with AI")}</a>
          <a className="act-button" href="#/automations">{t("All automations")}</a>
        </div>
      </header>
      <div className="lib-main">
        <div className="lib-controls-box">
          <div className="ops-filters lib-filters">
            <label className="ops-search">
              <span className="ops-sr"><Text>Search the library</Text></span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /><path d="M21 21l-6 -6" /></svg>
              <input type="search" value={query} placeholder={t("Search")} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <label className="ops-select">
              <span><Text>Wording</Text>:</span>
              <select value={style} onChange={(e) => setStyle(e.target.value as TemplateStyle)}>
                <option value="default">{t("Workspace language")}</option>
                <option value="taglish">{t("Taglish")}</option>
              </select>
            </label>
          </div>
          <div className="lib-chips" role="group" aria-label={t("Category")}>
            {(["All", ...TEMPLATE_CATEGORIES] as const).map((c) => (
              <button key={c} type="button" className="lib-chip" aria-pressed={category === c} onClick={() => setCategory(c)}>{t(c)}</button>
            ))}
          </div>
          {style === "taglish" && <p className="gp-hint"><Text>Taglish mixes Tagalog and English in the messages sent to your customers: payment links, reminders and receipts.</Text></p>}
        </div>
        {!card && <p role="alert" className="gp-error" hidden={!error}>{error}</p>}

        <ul className="lib-grid">
          {shown.map((c, idx) => {
            const sample = style === "taglish" ? taglishSampleFor(c.definition) : null;
            return (
              <li
                key={c.key}
                className="lib-card"
                style={{ "--card-index": Math.min(idx, 12) } as CSSProperties}
                data-selected={selected === c.key || undefined}
              >
                <h3 className="gp-name">
                  <button
                    type="button"
                    className="lib-open"
                    data-preview-key={c.key}
                    aria-pressed={selected === c.key}
                    aria-label={t("Preview: {name}", { name: c.name })}
                    onClick={() => open(c.key)}
                  >
                    {c.name}
                  </button>
                </h3>
                <p className="gp-sub">{c.description}</p>
                {meta(c.definition, c.template)}
                {sample && (
                  <div className="lib-card-sample">
                    <span><Text>Sample message</Text></span>
                    <p>{sample.subject ? `${sample.subject}: ${sample.body}` : sample.body}</p>
                  </div>
                )}
                <div className="lib-foot">
                  {useButton(c)}
                  {c.sample && <a className="ops-link" href={c.sample}><Text>Try the preview</Text></a>}
                </div>
              </li>
            );
          })}
        </ul>
        {!shown.length && (
          <div className="lib-empty" role="status">
            <p className="gp-hint"><Text>No templates match your search.</Text></p>
            <div className="gp-actions">
              <button type="button" className="ops-button" onClick={() => { setQuery(""); setCategory("All"); }}>
                <Text>Clear search</Text>
              </button>
              <a className="ops-button blue" href="#/ai">{t("Build with AI")}</a>
            </div>
          </div>
        )}
        <section className="lib-blank-footer" aria-label={blankName}>
          <div>
            <h2>{blankName}</h2>
            <p className="gp-sub">{blankText}</p>
          </div>
          <form className="lib-blank" onSubmit={createBlank}>
            <div className="gp-field">
              <label htmlFor="wf-name"><Text>Name</Text></label>
              <input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
            </div>
            <button className="ops-button" disabled={busy}><Text>Create and open editor</Text></button>
          </form>
        </section>
      </div>
      {!phone && card && (
        <div className="lib-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="lib-preview-title" tabIndex={-1} className="lib-dialog">
            {preview}
          </div>
        </div>
      )}
      {phone && card && (
        <Sheet title={card.name} onClose={close}>
          {preview}
        </Sheet>
      )}
    </main>
  );
}
