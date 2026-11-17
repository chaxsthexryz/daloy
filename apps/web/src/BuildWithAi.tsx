import type { WorkflowDefinition } from "@daloy/engine";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { saveDraft } from "./AiDraft";
import { ChoiceQuestion, PlanList } from "./AiFlow";
import { buildRequest, closestTemplate, plainDraft, questions, withLabels, withPeople, type Answers, type Member } from "./lib/ai-build";
import { AskRequest } from "./AskRequest";
import { Header } from "./Nav";
import { startOfficeSetup, startPurchaseSetup } from "./OfficeRequests";

type DraftReply = { name: string; summary: string; definition: WorkflowDefinition; warnings: string[] };
type Stage = "describe" | "questions" | "drafting" | "review" | "failed";

const EXAMPLES = [
  "When someone fills my contact form, thank them by email.",
  "When a client books a call, confirm it and remind them the day before.",
  "Remind my household to pay the electricity bill every month.",
];
/** Step types that need a connected app, with the provider name GET /settings/connections uses. */
const NEEDS: Record<string, { provider: string; label: string }> = {
  sheets: { provider: "google_sheets", label: "Google Sheet" },
  slack: { provider: "slack", label: "Slack" },
  outlook: { provider: "outlook", label: "Outlook" },
  teams: { provider: "teams", label: "Teams" },
};
const WHY: Record<string, string> = {
  "purchase-request": "You asked for an approval first. This one asks a person you name to approve each purchase.",
  "website-inquiry": "Visitors fill in your inquiry form and get a reply from your own email address.",
  "office-request": "Staff fill in a form, each request gets a reference, and your office is told.",
};
const SETUP_LABEL: Record<string, string> = { purchase: "Set up purchase requests", office: "Set up for my office", link: "Set up inquiry replies" };

/** #/ai (owners): the Build with AI flow of docs/console-navigation-plan.md section 4. The draft stays in this page until Save as draft. */
export function BuildWithAiPage({ email, ask = false }: { email: string; ask?: boolean }) {
  const [connected, setConnected] = useState<ReadonlySet<string>>(new Set());
  const [members, setMembers] = useState<Member[]>([]);
  const [ready, setReady] = useState(false);
  const [stage, setStage] = useState<Stage>("describe");
  const [description, setDescription] = useState("");
  const [answers, setAnswers] = useState<Answers>({});
  const [said, setSaid] = useState<string[]>([]);
  const [draft, setDraft] = useState<DraftReply | null>(null);
  const [failure, setFailure] = useState("");
  const [revision, setRevision] = useState(0);
  const [changing, setChanging] = useState(false);
  const [change, setChange] = useState("");
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeError, setChangeError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [setupError, setSetupError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const changeBox = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);

  // If either call fails the flow carries on with nothing connected and no team members to pick.
  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ connections: { provider: string; status: string }[] }>("GET", "/settings/connections").then(
        (r) => new Set(r.connections.filter((c) => c.status === "active").map((c) => c.provider)),
        () => new Set<string>(),
      ),
      api<{ email: string; role: string }[]>("GET", "/workspace/members").then(
        (list) => list.filter((m) => m.role !== "owner").map((m) => ({ email: m.email })),
        () => [] as Member[],
      ),
    ]).then(([c, m]) => {
      if (!live) return;
      setConnected(c);
      setMembers(m);
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const qs = useMemo(() => questions(connected, members), [connected, members]);
  const question = stage === "questions" ? qs.find((q) => !(q.id in answers)) : undefined;
  const picked = answers.who?.startsWith("member:") ? members[Number(answers.who.slice(7))] : undefined;
  const real = { owner: email, member1: picked?.email };

  // Each new stage, question or revised draft gets its heading read out. Not on first load.
  const focusKey = `${stage}:${Object.keys(answers).length}:${revision}`;
  useEffect(() => {
    if (mounted.current) heading.current?.focus();
    mounted.current = true;
  }, [focusKey]);
  useEffect(() => {
    if (changing) changeBox.current?.focus();
  }, [changing]);

  function startOver() {
    setStage("describe");
    setDescription("");
    setAnswers({});
    setSaid([]);
    setDraft(null);
    setFailure("");
    setChanging(false);
    setChange("");
    setChangeError("");
    setSaveError("");
    setSetupError("");
  }

  function next(e: FormEvent) {
    e.preventDefault();
    if (description.trim()) setStage("questions");
  }

  async function pick(id: string, value: string, label: string) {
    const all = { ...answers, [id]: value };
    setAnswers(all);
    setSaid([...said, label]);
    if (!qs.every((q) => q.id in all)) return;
    setStage("drafting");
    try {
      const reply = await api<DraftReply>("POST", "/ai/draft", { request: buildRequest(description, all, connected, members) });
      const who = all.who?.startsWith("member:") ? members[Number(all.who.slice(7))] : undefined;
      setDraft({ ...reply, definition: withPeople(reply.definition, { owner: email, member1: who?.email }) });
      setStage("review");
    } catch (err) {
      setFailure((err as Error).message);
      setStage("failed");
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!draft || !change.trim()) return;
    setChangeBusy(true);
    setChangeError("");
    try {
      const reply = await api<DraftReply>("POST", "/ai/draft", { request: change.trim(), current: withLabels(draft.definition, real) });
      setDraft({ ...reply, definition: withPeople(reply.definition, real) });
      setChanging(false);
      setChange("");
      setRevision(revision + 1);
    } catch (err) {
      setChangeError((err as Error).message);
    } finally {
      setChangeBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError("");
    try {
      const wf = await saveDraft(draft.name, draft.definition, draft.summary);
      location.hash = `#/w/${wf.id}`;
    } catch (err) {
      setSaveError((err as Error).message);
      setSaving(false);
    }
  }

  const recap = said.length > 0 && (
    <ul className="list" aria-label="What you have said so far">
      <li>You said: {description}</li>
      {said.map((s, i) => (
        <li key={i}>You said: {s}</li>
      ))}
    </ul>
  );

  return (
    <main className="page">
      <Header title="Build with AI" />
      <div className="ai-build">
        {ask && stage === "describe" && <AskRequest />}
        {stage === "describe" && (
          <form className="demo-card" onSubmit={next}>
            <h2 ref={heading} tabIndex={-1}>
              Describe it
            </h2>
            <div className="field">
              <label htmlFor="ai-description">What should happen?</label>
              <textarea id="ai-description" rows={4} maxLength={1200} required value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <p className="muted">Or start from an example:</p>
            <ul className="demo-starters">
              {EXAMPLES.map((x) => (
                <li key={x}>
                  <button type="button" onClick={() => setDescription(x)}>
                    {x}
                  </button>
                </li>
              ))}
            </ul>
            <p className="muted">The questions are asked by this page. Only your words, your tapped answers, and which apps are connected go to the AI. Nothing is saved until you choose Save as draft.</p>
            <div className="actions">
              <button className="primary" disabled={!ready}>
                Next
              </button>
            </div>
          </form>
        )}

        {stage === "questions" && question && (
          <>
            {recap}
            <ChoiceQuestion key={question.id} text={question.text} position={qs.indexOf(question) + 1} total={qs.length} choices={question.choices} allowOther focus={heading} note="The page asks these, not a model." onPick={(v, l) => pick(question.id, v, l)} />
            <div className="actions">
              <button type="button" className="quiet" onClick={startOver}>
                Start over
              </button>
            </div>
          </>
        )}

        {stage === "drafting" && (
          <>
            {recap}
            <div role="status">
              <h2 ref={heading} tabIndex={-1}>
                Drafting...
              </h2>
            </div>
          </>
        )}

        {stage === "review" && draft && (
          <section className="demo-card demo-review" aria-labelledby="review-title">
            <h2 id="review-title" ref={heading} tabIndex={-1}>
              Check the draft: {draft.name}
            </h2>
            <p>{draft.summary}</p>
            <PlanList lead={plainDraft(draft.definition).when} steps={plainDraft(draft.definition).steps} warnings={draft.warnings} cleanNote="The checker found nothing to fix." />
            <h3>Apps this needs</h3>
            {Object.keys(NEEDS).some((t) => draft.definition.steps.some((s) => s.type === t)) ? (
              <ul className="list">
                {Object.entries(NEEDS)
                  .filter(([t]) => draft.definition.steps.some((s) => s.type === t))
                  .map(([t, app]) => (
                    <li key={t}>
                      {app.label}: {connected.has(app.provider) ? "Connected" : <a href="#/apps">Connect in Apps</a>}
                    </li>
                  ))}
              </ul>
            ) : (
              <p>No apps are needed.</p>
            )}
            <p>Nothing is saved yet.</p>
            <div className="actions">
              <button type="button" className="primary" disabled={saving} onClick={save}>
                Save as draft
              </button>
              <button type="button" aria-expanded={changing} aria-controls="ai-change" onClick={() => setChanging(!changing)}>
                Change something
              </button>
              <button type="button" className="quiet" onClick={startOver}>
                Start over
              </button>
            </div>
            <p role="alert" className="message error" hidden={!saveError}>
              {saveError}
            </p>
            {changing && (
              <form id="ai-change" onSubmit={send}>
                <div className="field">
                  <label htmlFor="ai-change-text">What should change?</label>
                  <textarea id="ai-change-text" ref={changeBox} rows={3} maxLength={1200} required value={change} onChange={(e) => setChange(e.target.value)} />
                </div>
                <div className="actions">
                  <button className="primary" disabled={changeBusy || !change.trim()}>
                    Send
                  </button>
                </div>
                <p role="status" className="muted">
                  {changeBusy ? "Changing the draft..." : ""}
                </p>
                <p role="alert" className="message error" hidden={!changeError}>
                  {changeError}
                </p>
              </form>
            )}
          </section>
        )}

        {stage === "failed" && (
          <section className="demo-card" aria-labelledby="failed-title">
            <h2 id="failed-title" ref={heading} tabIndex={-1}>
              The AI is not set up, or it did not answer.
            </h2>
            <p>{failure}</p>
            <p>
              <a href="#/settings/ai">Check the AI model</a>
            </p>
            {(() => {
              const t = closestTemplate(answers, description);
              const kind = t.action ?? "link";
              return (
                <>
                  <h3>The closest ready-made automation: {t.label}</h3>
                  <p>{WHY[t.slug]}</p>
                  <div className="actions">
                    {t.href ? (
                      <a href={t.href}>{SETUP_LABEL[kind]}</a>
                    ) : (
                      <button type="button" className="primary" onClick={() => (t.action === "purchase" ? startPurchaseSetup(email) : startOfficeSetup(email)).catch((e: Error) => setSetupError(e.message))}>
                        {SETUP_LABEL[kind]}
                      </button>
                    )}
                    <button type="button" className="quiet" onClick={startOver}>
                      Start over
                    </button>
                  </div>
                  <p role="alert" className="message error" hidden={!setupError}>
                    {setupError}
                  </p>
                </>
              );
            })()}
          </section>
        )}
      </div>
    </main>
  );
}
