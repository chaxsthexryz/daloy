import { useId, useState, type ReactNode, type Ref } from "react";

type Choice = { value: string; label: string };

/** One question with answer buttons, shared by the public demo and the console's Build with AI flow. */
export function ChoiceQuestion({
  text,
  position,
  total,
  choices,
  onPick,
  focus,
  allowOther = false,
  note = "The page asks these, not a model.",
}: {
  text: string;
  position: number;
  total: number;
  choices: Choice[];
  onPick: (value: string, label: string) => void;
  /** Gives the question heading focus, so a screen reader announces the next question. */
  focus?: Ref<HTMLHeadingElement>;
  allowOther?: boolean;
  note?: string;
}) {
  const [other, setOther] = useState<string | null>(null);
  const id = useId();
  const typed = other?.trim() ?? "";
  return (
    <fieldset className="demo-question">
      <legend>
        <h2 ref={focus} tabIndex={-1}>
          {text}
        </h2>
      </legend>
      <p className="muted">
        Question {position} of {total}. {note}
      </p>
      <div className="demo-choices">
        {choices.map((c) => (
          <button key={c.value} type="button" onClick={() => onPick(c.value, c.label)}>
            {c.label}
          </button>
        ))}
        {allowOther && other === null && (
          <button type="button" onClick={() => setOther("")}>
            Other
          </button>
        )}
      </div>
      {allowOther && other !== null && (
        <div className="field demo-other">
          <label htmlFor={id}>Your own answer</label>
          <input id={id} type="text" maxLength={200} value={other} onChange={(e) => setOther(e.target.value)} />
          <div className="actions">
            <button type="button" className="primary" disabled={!typed} onClick={() => onPick(`other:${typed}`, typed)}>
              Use this answer
            </button>
          </div>
        </div>
      )}
    </fieldset>
  );
}

/** The numbered plan in words, then the checker's warnings. */
export function PlanList({
  lead,
  steps,
  warnings,
  stateOf,
  cleanNote = "The checker found nothing to fix.",
}: {
  lead: string;
  steps: string[];
  warnings: string[];
  /** Optional run-state badge shown after step i. */
  stateOf?: (i: number) => ReactNode;
  cleanNote?: string;
}) {
  return (
    <>
      <p>{lead}, Daloy will:</p>
      <ol className="numbered demo-plan">
        {steps.map((s, i) => (
          <li key={i}>
            {s}
            {stateOf?.(i)}
          </li>
        ))}
      </ol>
      <h3>Check before turning on</h3>
      {warnings.length ? (
        <ul className="list">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : (
        <p>{cleanNote}</p>
      )}
    </>
  );
}
