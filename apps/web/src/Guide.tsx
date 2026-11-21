import { configProblems, explainFlow, paymentMode, stepLines, withoutRecipient } from "@daloy/engine";
import { useState } from "react";
import { useLanguage } from "./Language";
import { Sheet } from "./Sheet";
import type { Run } from "./api";
import type { Draft } from "./lib/graph";
import type { AppNeed } from "./lib/editor";
import { guideSteps, type GuideKey, type TestState } from "./lib/guide";

const asRecord = (m: ReadonlyMap<string, string>) => Object.fromEntries(m);

const LABELS: Record<GuideKey, string> = {
  connect: "Connect the apps",
  message: "Check the messages",
  explain: "Read how it works",
  try: "Try a sample",
  turnon: "Turn on",
};

/** The five setup steps with a word for each state, and a way to do the step. */
export function SetupGuide({ facts, onExplain, onTry, onTurnOn }: { facts: Parameters<typeof guideSteps>[0]; onExplain: () => void; onTry: () => void; onTurnOn: () => void }) {
  const { t } = useLanguage();
  const act = (key: GuideKey) => {
    if (key === "connect") location.hash = "#/apps";
    else if (key === "message") document.getElementById("sample-checks")?.scrollIntoView({ block: "start" });
    else if (key === "explain") onExplain();
    else if (key === "try") onTry();
    else onTurnOn();
  };
  return (
    <section className="r2b-guide" aria-labelledby="r2b-guide-title">
      <h2 id="r2b-guide-title">{t("Setup guide")}</h2>
      <ol>
        {guideSteps(facts).map((s) => (
          <li key={s.key} data-done={s.done || undefined}>
            <span>{t(LABELS[s.key])}</span>
            <span className="r2b-state">{t(s.done ? "Done" : "To do")}</span>
            <button type="button" onClick={() => act(s.key)}>{t(s.done ? "Open" : "Go")}</button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** "Explain this flow": generated from the draft on screen, in the language the owner reads. */
export function ExplainSheet({ draft, chosen, onClose }: { draft: Draft; chosen: ReadonlyMap<string, string>; onClose: () => void }) {
  const { t, language } = useLanguage();
  return (
    <Sheet title={t("Explain this flow")} onClose={onClose}>
      <p className="wk-sheet-text">{t("This is what the draft will do, in the order it happens. Nothing is sent from this page.")}</p>
      <div className="r2b-lines">
        {explainFlow(draft, language, asRecord(chosen)).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <div className="wk-sheet-actions">
        <button type="button" className="wk-button blue" onClick={onClose}>{t("Got it")}</button>
      </div>
    </Sheet>
  );
}

const TEST_TEXT: Record<TestState, string> = {
  none: "No sample test yet.",
  stale: "Out of date: you changed the draft after the last sample test. Run it again.",
  running: "The sample test is running.",
  passed: "The last sample test passed.",
  failed: "The last sample test failed. Open the run to see why.",
};

/** Sample test results in three separate groups: configuration checks, simulated steps and live connections. */
export function SampleTest({ draft, apps, test, run, busy, onTry }: { draft: Draft; apps: AppNeed[]; test: TestState; run: Run | null; busy: boolean; onTry: () => void }) {
  const { t, language } = useLanguage();
  const [example, setExample] = useState(false);
  const problems = configProblems(draft, language);
  const failing = example ? configProblems(withoutRecipient(draft), language) : [];
  return (
    <section className="r2b-sample" id="sample-checks" aria-labelledby="r2b-sample-title">
      <h2 id="r2b-sample-title">{t("Try a sample")}</h2>
      <p>{t(TEST_TEXT[test])}</p>
      <h3>{t("Configuration checks")}</h3>
      {problems.length === 0 ? <p>{t("Every step has what it needs.")}</p> : <ul>{problems.map((p) => <li key={p.message}>{p.message}</li>)}</ul>}
      <h3>{t("Simulated steps")}</h3>
      {test === "none" || !run ? (
        <p>{t("Nothing is sent. Run the sample to see each step's outcome.")}</p>
      ) : (
        <ul>{run.steps.map((s) => <li key={s.id}><span className={`badge ${s.state}`}>{s.state}</span> {s.stepId}</li>)}</ul>
      )}
      <h3>{t("Live connections")}</h3>
      {apps.length === 0 ? <p>{t("This draft needs no connected app.")}</p> : <ul>{apps.map((a) => <li key={a.provider}>{t(a.label)}: {t(a.connected ? "Connected" : "Not connected")}</li>)}</ul>}
      <div className="actions">
        <button type="button" onClick={onTry} disabled={busy || draft.steps.length === 0}>{t("Try a sample")}</button>
        <button type="button" aria-pressed={example} onClick={() => setExample(!example)}>{t("Show a failing example")}</button>
      </div>
      {example && (
        <div className="r2b-example">
          <p>{t("Example only: your draft with its first recipient removed. Your draft is not changed.")}</p>
          {failing.length === 0 ? <p>{t("This draft has no recipient to remove.")}</p> : <ul>{failing.map((p) => <li key={p.message}>{p.message}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}

const PAYMENT: Record<NonNullable<ReturnType<typeof paymentMode>>, string> = {
  manual: "Manual QR Ph transfer, checked by a reviewer",
  checkout: "GCash checkout through PayMongo",
  later: "Pay later, with the balance outstanding",
};

/** The Turn on summary: the apps, recipients and payment mode this version will use. The owner decides. */
export function TurnOnSheet({ draft, apps, chosen, test, problems, onConfirm, onClose }: { draft: Draft; apps: AppNeed[]; chosen: ReadonlyMap<string, string>; test: TestState; problems: number; onConfirm: () => void; onClose: () => void }) {
  const { t, language } = useLanguage();
  const mode = paymentMode(draft);
  return (
    <Sheet title={t("Turn on this automation")} onClose={onClose}>
      <div className="r2b-lines">
        <h3>{t("Apps")}</h3>
        {apps.length === 0 ? <p>{t("No connected app is used.")}</p> : apps.map((a) => <p key={a.provider}>{t(a.label)}: {t(a.connected ? "Connected" : "Not connected")}</p>)}
        <h3>{t("Who gets what")}</h3>
        {stepLines(draft, language, asRecord(chosen)).map((l) => <p key={l.id}>{l.label}. {l.where}</p>)}
        <h3>{t("Payment")}</h3>
        <p>{mode ? t(PAYMENT[mode]) : t("This automation does not ask for payment.")}</p>
        <h3>{t("Sample test")}</h3>
        <p>{t(TEST_TEXT[test])}</p>
        {problems > 0 && <p className="message error">{t("{count} configuration checks still fail.", { count: problems })}</p>}
      </div>
      <p className="wk-sheet-text">{t("Turning on replaces the live version at once.")}</p>
      <div className="wk-sheet-actions">
        <button type="button" className="wk-button blue" onClick={onConfirm}>{t("Turn on")}</button>
        <button type="button" className="wk-button" onClick={onClose}>{t("Cancel")}</button>
      </div>
    </Sheet>
  );
}
