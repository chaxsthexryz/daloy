import { useId } from "react";

/**
 * Renders a form from the JSON Schema that z.toJSONSchema() produces for a step config.
 * It covers the shapes our step schemas use: strings, enums, integers, nested objects,
 * string maps (headers) and the string/number/boolean union of a condition's right side.
 */
export type JsonSchema = {
  type?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};
type Obj = Record<string, unknown>;

const LABELS: Record<string, string> = { op: "Operator", url: "URL", to: "To (comma-separated)", text: "Message", left: "Value", right: "Compare with" };
const label = (key: string) => LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);

export function SchemaForm({ schema, value, onChange }: { schema: JsonSchema; value: Obj; onChange: (v: Obj) => void }) {
  return (
    <>
      {Object.entries(schema.properties ?? {}).map(([key, s]) => (
        <Field
          key={key}
          name={key}
          schema={s}
          required={schema.required?.includes(key) ?? false}
          value={value[key]}
          onChange={(v) => {
            const next = { ...value };
            if (v === undefined) delete next[key];
            else next[key] = v;
            onChange(next);
          }}
        />
      ))}
    </>
  );
}

function Field({ name, schema, required, value, onChange }: { name: string; schema: JsonSchema; required: boolean; value: unknown; onChange: (v: unknown) => void }) {
  const id = useId();
  const text = (v: string) => onChange(v === "" && !required ? undefined : v);

  if (schema.type === "object" && schema.properties) {
    return (
      <fieldset>
        <legend>{label(name)}</legend>
        <SchemaForm schema={schema} value={(value as Obj) ?? {}} onChange={onChange} />
      </fieldset>
    );
  }
  if (schema.type === "object" && typeof schema.additionalProperties === "object") {
    return <MapField name={name} value={(value as Record<string, string>) ?? {}} onChange={onChange} />;
  }

  let input;
  if (schema.enum) {
    input = (
      <select id={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
        {schema.enum.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  } else if (schema.type === "integer" || schema.type === "number") {
    input = (
      <input
        id={id}
        type="number"
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === "integer" ? 1 : "any"}
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    );
  } else if (schema.anyOf) {
    // Numbers and true/false are stored as values, so "gt 100" compares numbers.
    const parse = (v: string) => (v === "true" ? true : v === "false" ? false : v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v);
    input = <input id={id} value={value === undefined || value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : parse(e.target.value))} />;
  } else if ((schema.maxLength ?? 0) > 2000) {
    input = <textarea id={id} rows={4} required={required} maxLength={schema.maxLength} value={String(value ?? "")} onChange={(e) => text(e.target.value)} />;
  } else {
    input = <input id={id} required={required} maxLength={schema.maxLength} value={String(value ?? "")} onChange={(e) => text(e.target.value)} />;
  }
  return (
    <div className="field">
      <label htmlFor={id}>
        {label(name)}
        {!required && <span className="muted"> (optional)</span>}
      </label>
      {input}
    </div>
  );
}

function MapField({ name, value, onChange }: { name: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const rows = Object.entries(value);
  const set = (next: [string, string][]) => onChange(Object.fromEntries(next));
  return (
    <fieldset>
      <legend>{label(name)}</legend>
      {rows.map(([k, v], i) => (
        <div className="row" key={i}>
          <input aria-label={`${label(name)} ${i + 1} name`} value={k} onChange={(e) => set(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <input aria-label={`${label(name)} ${i + 1} value`} value={v} onChange={(e) => set(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          <button type="button" className="quiet" onClick={() => set(rows.filter((_, j) => j !== i))} aria-label={`Remove ${k || "row"}`}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="quiet" onClick={() => set([...rows, [`X-Header-${rows.length + 1}`, ""]])}>
        Add {name === "headers" ? "header" : "entry"}
      </button>
    </fieldset>
  );
}
