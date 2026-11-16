import { defaultAnswers, officeRequestDefinition, parsePayload, previewOfficeRequest, SAMPLE_REQUEST, triggerFields } from "@daloy/engine";
import { useEffect, useRef, useState, type FormEvent } from "react";
import "./demo.css";

const setup = defaultAnswers("office@example.org");
const fields = triggerFields(officeRequestDefinition(setup).trigger)!;
const sample: Record<string, string> = {
  ...SAMPLE_REQUEST,
  summary: "The meeting-room projector won't turn on.",
  location: "Meeting room B",
};
const stages = [
  ["Record the request", "Add the issue to the office request list."],
  ["Notify the manager", "Prepare a message for the office inbox."],
  ["Return a receipt", "Give the requester a reference to follow up."],
];

function Emblem() {
  return <span className="astra-emblem" aria-hidden="true">✳</span>;
}

export function Demo() {
  const [result, setResult] = useState<ReturnType<typeof previewOfficeRequest> | null>(null);
  const [message, setMessage] = useState<"receipt" | "notification">("receipt");
  const [error, setError] = useState("");
  const panel = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    const old = document.title;
    document.title = "Astra Daloy | Office request desk";
    return () => { document.title = old; };
  }, []);
  useEffect(() => {
    if (moved.current) panel.current?.focus();
  }, [result]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = Object.fromEntries(fields.map(({ name }) => [name, String(data.get(name) ?? "").trim()]));
    const parsed = parsePayload(fields, values);
    if (!parsed.ok) {
      setError(parsed.errors.join(" · "));
      return;
    }
    moved.current = true;
    setError("");
    setResult(previewOfficeRequest(setup, values));
  }

  function reset() {
    setMessage("receipt");
    setResult(null);
  }

  return (
    <div className="astra">
      <header className="astra-mast">
        <div className="astra-wrap astra-bar">
          <div className="astra-wordmark"><Emblem /> Astra Daloy</div>
          <span className="astra-disclosure">Unofficial interactive demo</span>
        </div>
      </header>
      <main>
        <section className="astra-hero" aria-labelledby="desk-title">
          <div className="astra-wrap astra-hero-inner">
            <div>
              <h1 id="desk-title">Office request desk<span>.</span></h1>
              <p>Send a sample office request and follow it from the intake form to the manager’s inbox.</p>
            </div>
            <div className="astra-art" aria-hidden="true">
              <div className="astra-slip-back" />
              <div className="astra-slip">
                <div className="astra-slip-top"><span>ASTRA / DALOY</span><span>✳</span></div>
                <b>Request slip</b>
                <div className="astra-slip-rule" />
                <div className="astra-slip-bottom"><span className="astra-barcode" /><span>OFFICE COPY</span></div>
              </div>
            </div>
          </div>
        </section>
        <div className="astra-wrap astra-workspace">
          <section className="astra-paper" aria-labelledby="astra-panel">
            <div className="astra-paper-head">
              <div className="astra-paper-icon" aria-hidden="true">{result ? "✓" : "↳"}</div>
              <div>
                <h2 ref={panel} tabIndex={-1} id="astra-panel">{result ? "Request received" : "Request form"}</h2>
                <p>{result ? `Demo reference · ${result.reference}` : "Use the sample below or edit the details."}</p>
              </div>
            </div>
            {!result ? (
              <form onSubmit={submit} className="astra-fields">
                {fields.map((f) => (
                  <label key={f.name} className={f.name === "name" || f.name === "email" ? "" : "astra-wide"}>
                    {f.label}
                    {f.name === "summary"
                      ? <textarea name={f.name} defaultValue={sample[f.name]} required={f.required} maxLength={1000} rows={2} />
                      : <input name={f.name} type={f.type === "email" ? "email" : "text"} defaultValue={sample[f.name]} required={f.required} maxLength={f.type === "email" ? 254 : 1000} />}
                  </label>
                ))}
                {error && <p className="astra-error astra-wide" role="alert">{error}</p>}
                <div className="astra-actions astra-wide"><button className="astra-submit" type="submit">Submit demo request <span aria-hidden="true">→</span></button></div>
              </form>
            ) : (
              <>
                <section className="astra-mail" aria-label="Simulated inbox">
                  <h3>Simulated inbox</h3>
                  <div className="astra-switch">
                    <button aria-pressed={message === "receipt"} onClick={() => setMessage("receipt")}>Your receipt</button>
                    <button aria-pressed={message === "notification"} onClick={() => setMessage("notification")}>Manager notification</button>
                  </div>
                  <p className="astra-address">To {result[message].to}</p>
                  <h4>{result[message].subject}</h4>
                  <p className="astra-body">{result[message].text}</p>
                </section>
                <div className="astra-actions"><button className="astra-submit" onClick={reset}>Start again <span aria-hidden="true">↺</span></button></div>
              </>
            )}
          </section>
          <aside className="astra-history" aria-label="Run history">
            <header><h2>Run history</h2><span className="astra-count">{result ? "3" : "0"} of 3 complete</span></header>
            <ol className={result ? "astra-done" : ""}>
              {stages.map(([title, description], i) => (
                <li key={title}><span className="astra-marker" aria-hidden="true">{result ? "✓" : i + 1}</span>
                  <div><h3>{title}</h3><p>{description}</p></div>
                </li>
              ))}
            </ol>
            <p className="astra-note"><span aria-hidden="true">ⓘ</span> This simulation runs in your browser. Messages appear only in the demo inbox.</p>
          </aside>
        </div>
      </main>
    </div>
  );
}
