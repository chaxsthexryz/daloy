import { definitionSchema, lintDefinition, parsePayload, triggerFields, type FormField } from "@daloy/engine";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChoiceQuestion, PlanList } from "../AiFlow";
import { RunFlow } from "../FlowCanvas";
import { runFlow, STATUS, type FlowRun } from "../lib/run-flow";
import { matchScript, SCRIPTS, type Script } from "./scripts";
import { simulate, type SimRun } from "./simulate";

type Line = { who: "you" | "helper"; text: string };
type Decisions = Record<string, "approved" | "rejected">;

const STEP_MS = 900;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The public demo: the Build with AI flow of docs/console-navigation-plan.md section 4, in the console's frame, with
 * scripted replies and a run simulated in the page. No request leaves the browser and nothing is stored.
 */
export function Demo() {
  const [menu, setMenu] = useState(false);
  const [request, setRequest] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [script, setScript] = useState<Script>();
  const [offer, setOffer] = useState<Script[]>([]);
  const [introLength, setIntroLength] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [approved, setApproved] = useState(false);
  const [trigger, setTrigger] = useState<Record<string, unknown>>({});
  const [decisions, setDecisions] = useState<Decisions>({});
  const [run, setRun] = useState<SimRun | null>(null);
  const [shown, setShown] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const testHeading = useRef<HTMLHeadingElement>(null);
  const questionHeading = useRef<HTMLHeadingElement>(null);

  const question = script?.questions.find((q) => !(q.id in answers));
  const draft = useMemo(() => (script && !question ? script.draft(answers) : undefined), [script, question, answers]);
  const warnings = useMemo(() => (draft ? lintDefinition(definitionSchema.parse(draft.definition)) : []), [draft]);
  const fields: FormField[] = (draft && triggerFields(draft.definition.trigger)) ?? [];

  useEffect(() => {
    if (draft && !approved) reviewHeading.current?.focus();
  }, [draft, approved]);
  useEffect(() => {
    if (approved) testHeading.current?.focus();
  }, [approved]);
  useEffect(() => {
    if (script && question && Object.keys(answers).length > 0) questionHeading.current?.focus();
  }, [script, question, answers]);
  // One step a little under a second apart, so the visitor can follow the path. Reduced motion shows the result at once.
  useEffect(() => {
    if (!run || shown >= run.steps.length) return;
    const timer = setTimeout(() => setShown((n) => n + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [run, shown]);

  function clearRun() {
    setRun(null);
    setShown(0);
    setDecisions({});
    setErrors([]);
  }

  function startOver() {
    setRequest("");
    setLines([]);
    setScript(undefined);
    setOffer([]);
    setAnswers({});
    setApproved(false);
    clearRun();
  }

  function followScript(s: Script, before: Line[]) {
    const intro = [...before, { who: "helper" as const, text: s.reply }];
    setLines(intro);
    setIntroLength(intro.length);
    setScript(s);
    setOffer([]);
    setAnswers({});
    setApproved(false);
    clearRun();
  }

  function ask(text: string) {
    const words = text.trim();
    if (!words) return;
    const you: Line = { who: "you", text: words };
    const found = SCRIPTS.find((s) => s.prompt === words);
    if (found) return followScript(found, [you]);
    const match = matchScript(words);
    if (match.script && match.sure) return followScript(match.script, [you, { who: "helper", text: `Your words fit the scripted example "${match.script.title}", so this demo follows that script.` }]);
    startOver();
    setRequest(words);
    setLines([
      you,
      {
        who: "helper",
        text: `This demo has no live model, so it cannot draft what you wrote. It can only follow three scripted examples. ${match.script ? `The nearest is "${match.script.title}".` : "None of them is close to your words."} The live helper is being built.`,
      },
    ]);
    setOffer(match.script ? [match.script, ...SCRIPTS.filter((s) => s !== match.script)] : SCRIPTS);
  }

  function answer(id: string, value: string, label: string) {
    const next = { ...answers, [id]: value };
    const done = script!.questions.every((q) => q.id in next);
    setLines([...lines, { who: "you", text: label }, ...(done ? [{ who: "helper" as const, text: "Here is the draft. Check it before you approve it." }] : [])]);
    setAnswers(next);
  }

  function changeAnswers() {
    setLines(lines.slice(0, introLength));
    setAnswers({});
    setApproved(false);
    clearRun();
  }

  function sendTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = Object.fromEntries(fields.map((f) => [f.name, String(data.get(f.name) ?? "").trim()]));
    const parsed = parsePayload(fields, values);
    if (!parsed.ok) return setErrors(parsed.errors);
    const next = simulate(draft!.definition, parsed.data, {});
    setErrors([]);
    setTrigger(parsed.data);
    setDecisions({});
    setRun(next);
    setShown(reducedMotion() ? next.steps.length : 0);
  }

  function decide(stepId: string, decision: "approved" | "rejected") {
    const all = { ...decisions, [stepId]: decision };
    const next = simulate(draft!.definition, trigger, all);
    setDecisions(all);
    setRun(next);
    if (reducedMotion()) setShown(next.steps.length);
  }

  // The rows runFlow reads, as the worker would write them: the steps shown so far, then the one now working.
  const flowRun: FlowRun | null = run && {
    state: shown < run.steps.length ? "running" : run.state,
    // A step waiting for the visitor's own answer reads "Needs you", as in the approved frame.
    needsReview: shown >= run.steps.length && run.state === "waiting",
    steps: [
      ...run.steps.slice(0, shown).map((r, i) => ({ stepId: r.stepId, state: r.state, branch: r.branch, createdAt: String(i).padStart(4, "0") })),
      ...(shown < run.steps.length ? [{ stepId: run.steps[shown]!.stepId, state: "running", branch: null, createdAt: String(shown).padStart(4, "0") }] : []),
    ],
  };
  const states = draft && flowRun ? runFlow(draft.definition, flowRun).nodes : undefined;
  const visible = run ? run.steps.slice(0, shown) : [];
  const finished = !!run && shown >= run.steps.length;
  const planOf = (id: string) => draft?.plan[draft.definition.steps.findIndex((s) => s.id === id)] ?? id;
  const status = !run
    ? ""
    : !finished
      ? `Working: ${planOf(run.steps[shown]!.stepId)}`
      : run.state === "waiting"
        ? "Waiting for your approval. Open the approval in the inbox below."
        : "Finished. Nothing was sent: every message is only in this page.";

  return (
    <div className="demo">
      <p className="demo-banner">
        <b>Demo in your browser.</b> Nothing is saved or sent. The AI replies are scripted examples, not a live model.
      </p>
      <div className="dm-app">
        <aside className="dm-side">
          <div className="dm-top">
            <div className="dm-brand">
              <svg viewBox="0 0 30 30" width="30" height="30" role="img" aria-label="kymavo">
                <rect width="30" height="30" rx="8" fill="#1b45c9" />
                <path d="M8 18.5 15 12l7 6.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>kymavo</span>
            </div>
            <button type="button" className="dm-menu-button" aria-expanded={menu} aria-controls="demo-menu" onClick={() => setMenu(!menu)}>
              Menu
            </button>
          </div>
          <nav id="demo-menu" aria-label="Main" className={menu ? "dm-nav open" : "dm-nav"}>
            <a href="#build" aria-current="page" onClick={() => setMenu(false)}>
              Build with AI
            </a>
            <a href="../">About kymavo</a>
            <span className="who">Demo account. Nothing is saved.</span>
          </nav>
        </aside>
        <main className="dm-main">
          <div className="dm-page">
            <header className="dm-head">
              <h1 id="build">Build with AI</h1>
              {lines.length > 0 && (
                <button type="button" onClick={startOver}>
                  Start over
                </button>
              )}
            </header>

          <div className={draft ? "demo-grid split" : "demo-grid"}>
            <section className="demo-chat" aria-labelledby="chat-title">
              <h2 id="chat-title" className="sr-only">
                Conversation
              </h2>
              {lines.length === 0 && (
                <form
                  className="demo-card demo-ask"
                  onSubmit={(e) => {
                    e.preventDefault();
                    ask(request);
                  }}
                >
                  <div className="field">
                    <label htmlFor="demo-request">What should happen?</label>
                    <textarea id="demo-request" rows={3} maxLength={500} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Describe a task in your own words, or pick an example below." />
                  </div>
                  <div className="actions">
                    <button className="primary" disabled={!request.trim()}>
                      Ask the helper
                    </button>
                  </div>
                  <h3 className="demo-label">Examples</h3>
                  <ul className="demo-starters">
                    {SCRIPTS.map((s) => (
                      <li key={s.id}>
                        <button type="button" onClick={() => ask(s.prompt)}>
                          <span className="tag">{s.audience}</span>
                          <span>{s.prompt}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </form>
              )}

              {lines.length > 0 && (
                <ol className="chat demo-lines" aria-live="polite">
                  {lines.map((l, i) => (
                    <li key={i} className={l.who === "you" ? "demo-you" : "demo-helper"}>
                      <span className="demo-who">{l.who === "you" ? "You" : "kymavo helper (scripted example)"}</span>
                      {l.text}
                    </li>
                  ))}
                </ol>
              )}

              {offer.length > 0 && (
                <div className="demo-offer">
                  <p>Pick an example to see the flow:</p>
                  <ul className="demo-starters">
                    {offer.map((s) => (
                      <li key={s.id}>
                        <button type="button" onClick={() => followScript(s, [...lines, { who: "you", text: `Show "${s.title}"` }])}>
                          <span className="tag">{s.audience}</span>
                          <span>{s.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="quiet" onClick={startOver}>
                    Write something else
                  </button>
                </div>
              )}

              {script && question && (
                <ChoiceQuestion
                  text={question.text}
                  position={script.questions.indexOf(question) + 1}
                  total={script.questions.length}
                  choices={question.choices}
                  focus={questionHeading}
                  onPick={(value, label) => answer(question.id, value, label)}
                />
              )}

              {draft && (
                <section className="demo-card demo-review" aria-labelledby="review-title">
                  <h2 id="review-title" ref={reviewHeading} tabIndex={-1}>
                    {approved ? "Approved draft" : "Check the draft"}: {draft.name}
                  </h2>
                  <PlanList
                    lead={draft.when}
                    steps={draft.definition.steps.map((_, i) => draft.plan[i] ?? "")}
                    warnings={warnings}
                    cleanNote="The checker found nothing to fix. This is kymavo's real checker, run in your browser."
                    stateOf={(i) => {
                      const id = draft.definition.steps[i]!.id;
                      return (
                        states && (
                          <span className={`state ${states[id]}`}>
                            <span aria-hidden="true">{STATUS[states[id]!].symbol}</span> {STATUS[states[id]!].label}
                          </span>
                        )
                      );
                    }}
                  />
                  {!approved ? (
                    <div className="actions">
                      <button type="button" className="primary" onClick={() => setApproved(true)}>
                        Approve draft
                      </button>
                      <button type="button" onClick={changeAnswers}>
                        Change answers
                      </button>
                    </div>
                  ) : (
                    <p className="muted">In kymavo, an approved draft is saved switched off. You test it, then turn it on. Here it lives only in this page.</p>
                  )}
                </section>
              )}

              {draft && approved && (
                <section className="demo-card demo-test" aria-labelledby="test-title">
                  <h2 id="test-title" ref={testHeading} tabIndex={-1}>
                    Send a test
                  </h2>
                  <form onSubmit={sendTest} key={script!.id + JSON.stringify(answers)}>
                    {fields.length === 0 ? (
                      <p>{draft.when}, the schedule starts a run. Run it now to see what would happen.</p>
                    ) : (
                      <p>{draft.definition.trigger.type === "webhook" ? "A sample web request, as your system would send it." : "A sample form entry."} Edit it if you like.</p>
                    )}
                    {fields.map((f) => (
                      <div className="field" key={f.name}>
                        <label htmlFor={`f-${f.name}`}>{f.label}</label>
                        {f.type === "textarea" ? (
                          <textarea id={`f-${f.name}`} name={f.name} rows={2} defaultValue={script!.sample[f.name]} />
                        ) : (
                          <input
                            id={`f-${f.name}`}
                            name={f.name}
                            type={f.type === "email" ? "email" : f.type === "datetime" ? "datetime-local" : "text"}
                            inputMode={f.type === "number" ? "decimal" : undefined}
                            defaultValue={script!.sample[f.name]}
                          />
                        )}
                      </div>
                    ))}
                    {errors.length > 0 && (
                      <ul className="message error" role="alert">
                        {errors.map((e) => (
                          <li key={e}>{e}</li>
                        ))}
                      </ul>
                    )}
                    <div className="actions">
                      <button className="primary">{fields.length ? "Send the test" : "Run it now"}</button>
                    </div>
                  </form>
                  <p className="demo-status" role="status">
                    {status}
                  </p>
                </section>
              )}
            </section>

            <div className="demo-side">
              {draft && (
                <section aria-label="Diagram" className="demo-canvas">
                  <RunFlow draft={draft.definition} run={flowRun} colorMode="light" />
                  <p className="demo-caption">Each box becomes Done, Waiting or Needs you as the test runs.</p>
                </section>
              )}
              {run && (
                <section className="demo-inbox" aria-labelledby="inbox-title">
                  <h2 id="inbox-title">Simulated inbox</h2>
                  {visible.filter((r) => r.message || r.note).length === 0 && <p className="muted">Messages appear here as each step runs.</p>}
                  <ul>
                    {visible.map((r) =>
                      r.message ? (
                        <li key={r.stepId} className="card">
                          <p className="muted">
                            {r.message.kind === "sheets" || r.message.kind === "slack" ? r.message.to : `To ${r.message.to}`}
                          </p>
                          <h3>{r.message.subject}</h3>
                          <p className="demo-body">{r.message.text}</p>
                          {r.message.kind === "approval" &&
                            (r.state === "waiting" ? (
                              <div className="actions">
                                <button type="button" className="primary" onClick={() => decide(r.stepId, "approved")}>
                                  Approve
                                </button>
                                <button type="button" onClick={() => decide(r.stepId, "rejected")}>
                                  Decline
                                </button>
                              </div>
                            ) : (
                              <p className="tag ok">{r.branch === "approved" ? "You approved" : "You declined"}</p>
                            ))}
                        </li>
                      ) : r.note ? (
                        <li key={r.stepId} className="card">
                          <p className="muted">{planOf(r.stepId)}</p>
                          <p>{r.note}</p>
                        </li>
                      ) : null,
                    )}
                  </ul>
                  {finished && run.state === "succeeded" && (
                    <div className="actions">
                      <button type="button" onClick={startOver}>
                        Try another example
                      </button>
                    </div>
                  )}
                </section>
              )}
            </div>
          </div>
        </div>
        </main>
      </div>
    </div>
  );
}
