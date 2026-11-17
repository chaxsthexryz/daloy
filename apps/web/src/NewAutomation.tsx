import { TEMPLATES } from "@daloy/engine";
import { useState, type FormEvent } from "react";
import { api, ApiError, type Workflow } from "./api";
import { BuildWithAi } from "./AiDraft";
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
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState("");
  const [startError, setStartError] = useState("");

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const wf = await api<Workflow>("POST", "/workflows", { name, slug: slugify(name) || "workflow" });
      const t = TEMPLATES.find((t) => t.slug === template);
      if (t) await api("POST", `/workflows/${wf.id}/versions`, { definition: t.definition, publish: false });
      location.hash = `#/w/${wf.id}`;
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "An automation with that name already exists." : (err as Error).message);
    }
  };

  return (
    <main className="page">
      <Header title="New automation" />
      <section className="create" aria-labelledby="guided">
        <h2 id="guided">Set up with a few questions</h2>
        <h3>Track an office request</h3>
        <p>Staff fill in a form. Each request gets a reference. Your office receives a notification.</p>
        <div className="actions">
          <a href="#/try/office-request">Try an example</a>
          <button type="button" className="primary" onClick={() => startOfficeSetup(email).catch((e: Error) => setStartError(e.message))}>
            Set up for my office
          </button>
        </div>
        <h3>Purchase request with a named approver</h3>
        <p>Staff ask to buy something and get a reference. The person you name approves or rejects it in Daloy. Approved requests go to purchasing, from Outlook and with a Teams note if you connect them.</p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => startPurchaseSetup(email).catch((e: Error) => setStartError(e.message))}>
            Set up purchase requests
          </button>
        </div>
        <h3>Reply to a website inquiry</h3>
        <p>Visitors fill in your inquiry form. They get a reply from your own email address, and your inbox gets the inquiry.</p>
        <div className="actions">
          <a href="#/settings/business">Set up inquiry replies</a>
        </div>
        <p role="alert" className="message error" hidden={!startError}>
          {startError}
        </p>
      </section>
      <BuildWithAi />
      <form onSubmit={create} className="create">
        <h2>Blank or from a template, for a technician</h2>
        <p className="muted">Opens the diagram editor. You add and connect the steps yourself.</p>
        <div className="row">
          <div className="field">
            <label htmlFor="wf-name">Name</label>
            <input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="wf-template">Start from</label>
            <select id="wf-template" value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="">Blank</option>
              {TEMPLATES.map((t) => (
                <option key={t.slug} value={t.slug}>
                  Template: {t.name}
                </option>
              ))}
            </select>
          </div>
          <button className="primary">Create</button>
        </div>
        {template && <p className="muted hint">{TEMPLATES.find((t) => t.slug === template)!.description}</p>}
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
      </form>
    </main>
  );
}
