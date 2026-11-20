import "./automations-ops.css";
import "./guided-pages.css";
import { templatesForLanguage } from "@daloy/engine";
import { Text, useLanguage } from "./Language";
import { useState, type FormEvent } from "react";
import { api, ApiError, type Workflow } from "./api";
import { startOfficeSetup, startPurchaseSetup } from "./OfficeRequests";
import type { Language } from "./lib/locale";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

/** #/new: every way to start an automation on one page (Doop frame NycmMp8U-t), guided templates first. */
export function NewAutomationPage({ email }: { email: string }) {
  const { language, t } = useLanguage();
  const templates = templatesForLanguage(language);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState("");
  const [startError, setStartError] = useState("");
  // One start or create at a time: a repeated click must not make a second draft.
  const [busy, setBusy] = useState(false);

  const start = (go: (email: string, language: Language) => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setStartError("");
    go(email, language).catch((e: Error) => {
      setStartError(e.message);
      setBusy(false);
    });
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const wf = await api<Workflow>("POST", "/workflows", { name, slug: slugify(name) || "workflow" });
      const t = templates.find((t) => t.slug === template);
      if (t) {
        const ownerEmail = email.trim();
        const definition = ownerEmail
          ? {
              ...t.definition,
              steps: t.definition.steps.map((s) => {
                const cfg = s.config as Record<string, unknown>;
                const nextCfg = { ...cfg };
                if (nextCfg.to === "owner@example.com") nextCfg.to = ownerEmail;
                if (nextCfg.approver === "owner@example.com") nextCfg.approver = ownerEmail;
                return { ...s, config: nextCfg };
              }),
            }
          : t.definition;
        await api("POST", `/workflows/${wf.id}/versions`, { definition, publish: false });
      }
      location.hash = `#/w/${wf.id}`;
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? t("An automation with that name already exists.") : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="page ops gp motion-page">
      <header className="ops-head">
        <div className="gp-title">
          <p className="gp-crumb"><a href="#/"><Text>Automations</Text></a></p>
          <h1><Text>New automation</Text></h1>
        </div>
        <div className="ops-actions">
          <a className="ops-button" href="#/ai">{t("Build with AI")}</a>
        </div>
      </header>
      <div className="ops-layout">
        <div className="ops-main">
          <section className="gp-section" aria-labelledby="guided">
            <h2 id="guided"><Text>Start with a template</Text></h2>
            <p className="gp-lead"><Text>Choose the workflow closest to the way your team works.</Text></p>
            <table className="ops-table gp-table">
              <thead>
                <tr>
                  <th scope="col"><Text>Template</Text></th>
                  <th scope="col"><Text>Starts with</Text></th>
                  <th scope="col"><Text>Setup</Text></th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="c-main">
                    <span className="gp-name"><Text>Track an office request</Text></span>
                    <span className="gp-sub"><Text>Record requests and notify your office.</Text></span>
                  </td>
                  <td className="c-start"><Text>Staff form</Text></td>
                  <td className="c-act">
                    <button type="button" className="ops-button" disabled={busy} aria-label={t("Set up for my office")} onClick={() => start(startOfficeSetup)}>
                      <Text>Set up</Text>
                    </button>
                  </td>
                </tr>
                <tr>
                  <td className="c-main">
                    <span className="gp-name"><Text>Purchase request with approval</Text></span>
                    <span className="gp-sub"><Text>Ask a reviewer before notifying purchasing.</Text></span>
                  </td>
                  <td className="c-start"><Text>Purchase form</Text></td>
                  <td className="c-act">
                    <button type="button" className="ops-button" disabled={busy} aria-label={t("Set up purchase requests")} onClick={() => start(startPurchaseSetup)}>
                      <Text>Set up</Text>
                    </button>
                  </td>
                </tr>
                <tr>
                  <td className="c-main">
                    <span className="gp-name"><Text>Reply to a website inquiry</Text></span>
                    <span className="gp-sub"><Text>Reply to the sender and notify your team.</Text></span>
                  </td>
                  <td className="c-start"><Text>Inquiry form</Text></td>
                  <td className="c-act">
                    <a className="ops-link" href="#/settings/business" aria-label={t("Business setup: set up inquiry replies")}>
                      <Text>Business setup</Text>
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
            <p role="alert" className="gp-error" hidden={!startError}>
              {startError}
            </p>
          </section>

          <form onSubmit={create} className="gp-card" aria-labelledby="blank">
            <h2 id="blank"><Text>Start with a blank workflow</Text></h2>
            <p className="gp-hint"><Text>Choose a trigger, then add and connect the steps in the editor.</Text></p>
            <div className="gp-inline">
              <div className="gp-field">
                <label htmlFor="wf-name"><Text>Name</Text></label>
                <input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
              </div>
              <div className="gp-field">
                <label htmlFor="wf-template"><Text>Start from</Text></label>
                <select id="wf-template" value={template} onChange={(e) => setTemplate(e.target.value)}>
                  <option value="">{t("Blank")}</option>
                  {templates.map((item) => (
                    <option key={item.slug} value={item.slug}>
                      {t("Template: {name}", { name: t(item.name) })}
                    </option>
                  ))}
                </select>
              </div>
              <button className="ops-button" disabled={busy}><Text>Create and open editor</Text></button>
            </div>
            {template && <p className="gp-hint">{t(templates.find((item) => item.slug === template)!.description)}</p>}
            <p role="alert" className="gp-error" hidden={!error}>
              {error}
            </p>
          </form>
        </div>

        <aside className="ops-panel" aria-labelledby="preview-title">
          <p className="gp-eyebrow"><Text>Preview a template</Text></p>
          <h2 id="preview-title"><Text>Office requests</Text></h2>
          <p className="gp-lead"><Text>Try the sample form before setting up a workflow for your team.</Text></p>
          <ol className="gp-steps">
            <li>
              <b aria-hidden="true">1</b>
              <strong><Text>Submit a request</Text></strong>
              <span><Text>A staff member describes what they need.</Text></span>
            </li>
            <li>
              <b aria-hidden="true">2</b>
              <strong><Text>Record it</Text></strong>
              <span><Text>The office gets a reference and a row in its list.</Text></span>
            </li>
            <li>
              <b aria-hidden="true">3</b>
              <strong><Text>Send a receipt</Text></strong>
              <span><Text>The requester gets a copy by email.</Text></span>
            </li>
          </ol>
          <div className="gp-actions">
            <a className="ops-button blue" href="#/try/office-request"><Text>Try the preview</Text></a>
          </div>
        </aside>
      </div>
    </main>
  );
}
