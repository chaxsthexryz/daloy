import "./creation.css";
import { templatesForLanguage } from "@daloy/engine";
import { Text, useLanguage } from "./Language";
import { useState, type FormEvent } from "react";
import { api, ApiError, type Workflow } from "./api";
import { Header } from "./Nav";
import { startOfficeSetup, startPurchaseSetup } from "./OfficeRequests";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

/** #/new: every way to start an automation on one page, guided templates first. */
export function NewAutomationPage({ email }: { email: string }) {
  const { language, t } = useLanguage();
  const templates = templatesForLanguage(language);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState("");
  const [startError, setStartError] = useState("");

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const wf = await api<Workflow>("POST", "/workflows", { name, slug: slugify(name) || "workflow" });
      const t = templates.find((t) => t.slug === template);
      if (t) await api("POST", `/workflows/${wf.id}/versions`, { definition: t.definition, publish: false });
      location.hash = `#/w/${wf.id}`;
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? t("An automation with that name already exists.") : (err as Error).message);
    }
  };

  return (
    <main className="page creation-page new-automation">
      <Header title={t("New automation")} />
      <section className="create" aria-labelledby="guided">
        <h2 id="guided"><Text>Set up with a few questions</Text></h2>
        <div className="creation-options">
          <article className="creation-option">
            <h3><Text>Track an office request</Text></h3>
            <p><Text>Staff fill in a form. Each request gets a reference. Your office receives a notification.</Text></p>
            <div className="actions">
              <a href="#/try/office-request"><Text>Try an example</Text></a>
              <button type="button" className="primary" onClick={() => startOfficeSetup(email, language).catch((e: Error) => setStartError(e.message))}>
                {t("Set up for my office")}
              </button>
            </div>
          </article>
          <article className="creation-option">
            <h3><Text>Purchase request with a named approver</Text></h3>
            <p><Text>Staff ask to buy something and get a reference. The person you name approves or rejects it in Daloy. Approved requests go to purchasing, from Outlook and with a Teams note if you connect them.</Text></p>
            <div className="actions">
              <button type="button" className="primary" onClick={() => startPurchaseSetup(email, language).catch((e: Error) => setStartError(e.message))}>
                {t("Set up purchase requests")}
              </button>
            </div>
          </article>
          <article className="creation-option">
            <h3><Text>Reply to a website inquiry</Text></h3>
            <p><Text>Visitors fill in your inquiry form. They get a reply from your own email address, and your inbox gets the inquiry.</Text></p>
            <div className="actions">
              <a href="#/settings/business"><Text>Set up inquiry replies</Text></a>
            </div>
          </article>
        </div>
        <p role="alert" className="message error" hidden={!startError}>
          {startError}
        </p>
      </section>
      <section className="create creation-ai-entry" aria-labelledby="describe-ai">
        <h2 id="describe-ai"><Text>Describe it to the AI</Text></h2>
        <p><Text>Say what should happen in your own words, answer a few questions, and check the draft before anything is saved.</Text></p>
        <div className="actions">
          <a href="#/ai" className="primary">
            {t("Build with AI")}
          </a>
        </div>
      </section>
      <form onSubmit={create} className="create">
        <h2><Text>Blank or from a template, for a technician</Text></h2>
        <p className="muted"><Text>Opens the diagram editor. You add and connect the steps yourself.</Text></p>
        <div className="row">
          <div className="field">
            <label htmlFor="wf-name"><Text>Name</Text></label>
            <input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
          </div>
          <div className="field">
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
          <button className="primary"><Text>Create</Text></button>
        </div>
        {template && <p className="muted hint">{t(templates.find((item) => item.slug === template)!.description)}</p>}
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
      </form>
    </main>
  );
}
