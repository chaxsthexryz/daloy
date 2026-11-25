import { conditionOpLabel, formatDuration } from "@daloy/engine";
import { useLanguage } from "./Language";
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
  description?: string;
  items?: JsonSchema;
};
type Obj = Record<string, unknown>;

const LABELS: Record<string, string> = { amount: "Amount (pesos)", reference: "Order reference", op: "Operator", url: "URL", selector: "CSS selector", maxChars: "Most characters to keep", to: "To (comma-separated)", text: "Message", message: "Message", senderId: "Sender ID", mode: "Mode", templateName: "Template name", templateLanguage: "Template language", templateParams: "Template parameters", left: "Value", right: "Compare with", timeoutSeconds: "Timeout (seconds)", seconds: "Wait (seconds)", offsetSeconds: "Offset (seconds)", sku: "SKU", imageUrl: "Image link", by: "Find the product by", product: "Product id or SKU", workflowSlug: "Automation slug", payload: "Inputs", what: "What to read", value: "Value", timezone: "Time zone", format: "Date format", separator: "Separator", fields: "Fields", columns: "Columns", rows: "Rows list", header: "Header row" };
const label = (key: string, schema?: JsonSchema) =>
  key === "to" && (schema?.description?.includes("Philippine mobile") || schema?.description?.includes("WhatsApp phone")) ? "Recipient phone" : (LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1));

export function SchemaForm({ schema, value, onChange }: { schema: JsonSchema; value: Obj; onChange: (v: Obj) => void }) {
  return (
    <>
      {/* A list of objects (a menu's buttons) has no form yet; it is kept as saved, since onChange copies the whole value. */}
      {Object.entries(schema.properties ?? {}).filter(([, s]) => !(s.type === "array" && s.items?.type === "object")).map(([key, s]) => (
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
  const { t, language } = useLanguage();
  const id = useId();
  const text = (v: string) => onChange(v === "" && !required ? undefined : v);

  if (schema.type === "object" && schema.properties) {
    return (
      <fieldset>
        <legend>{t(label(name))}</legend>
        <SchemaForm schema={schema} value={(value as Obj) ?? {}} onChange={onChange} />
      </fieldset>
    );
  }
  if (schema.type === "object" && typeof schema.additionalProperties === "object") {
    return <MapField name={name} value={(value as Record<string, string>) ?? {}} onChange={onChange} />;
  }
  if (schema.type === "array" && schema.items?.type === "string") {
    return <ListField name={name} value={Array.isArray(value) ? (value as string[]) : []} required={required} onChange={(next) => onChange(next.length === 0 && !required ? undefined : next)} />;
  }

  let input;
  const durationHint =
    (name === "seconds" || name === "timeoutSeconds" || name === "offsetSeconds") && typeof value === "number" && Number.isFinite(value)
      ? formatDuration(Math.abs(value), language)
      : null;
  if (schema.enum) {
    input = (
      <select id={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value === "" && !required ? undefined : e.target.value)}>
        {!required && <option value="">{t("(default)")}</option>}
        {schema.enum.map((o) => (
          <option key={o} value={o}>{name === "op" ? conditionOpLabel(o, language) : t(o)}</option>
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
    const acceptsArray = schema.anyOf.some((s) => s.type === "array");
    const parse = (v: string) => {
      if (acceptsArray && v.trim().startsWith("[")) {
        try {
          const parsed: unknown = JSON.parse(v);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // keep as string until valid JSON
        }
      }
      if (v === "true") return true;
      if (v === "false") return false;
      return v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
    };
    const shown = value === undefined || value === null ? "" : Array.isArray(value) ? JSON.stringify(value) : String(value);
    input = <input id={id} data-variable-target value={shown} onChange={(e) => onChange(e.target.value === "" ? undefined : parse(e.target.value))} />;
  } else if ((schema.maxLength ?? 0) > 2000) {
    input = <textarea id={id} data-variable-target rows={4} required={required} maxLength={schema.maxLength} value={String(value ?? "")} onChange={(e) => text(e.target.value)} />;
  } else {
    input = <input id={id} data-variable-target required={required} maxLength={schema.maxLength} value={String(value ?? "")} onChange={(e) => text(e.target.value)} />;
  }
  return (
    <div className="field">
      <label htmlFor={id}>
        {t(label(name, schema))}
        {!required && <span className="muted">{t(" (optional)")}</span>}
      </label>
      {input}
      {durationHint && <p className="muted">{durationHint}</p>}
      {schema.description && <p className="muted">{t(schema.description)}</p>}
    </div>
  );
}

function MapField({ name, value, onChange }: { name: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const { t } = useLanguage();
  const rows = Object.entries(value);
  const set = (next: [string, string][]) => onChange(Object.fromEntries(next));
  return (
    <fieldset>
      <legend>{t(label(name))}</legend>
      {rows.map(([k, v], i) => (
        <div className="row" key={i}>
          <input aria-label={t("{field} {number} name", { field: t(label(name)), number: i + 1 })} value={k} onChange={(e) => set(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <input data-variable-target aria-label={t("{field} {number} value", { field: t(label(name)), number: i + 1 })} value={v} onChange={(e) => set(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          <button type="button" className="quiet" onClick={() => set(rows.filter((_, j) => j !== i))} aria-label={t("Remove {name}", { name: k || t("row") })}>{t("Remove")}</button>
        </div>
      ))}
      {/* New names must already pass the schema: headers allow capitals and dashes, ai labels and fields only a-z, 0-9 and _. */}
      <button type="button" className="quiet" onClick={() => set([...rows, [name === "headers" ? `X-Header-${rows.length + 1}` : `${name.replace(/s$/, "")}_${rows.length + 1}`, ""]])}>{t(name === "headers" ? "Add header" : "Add entry")}
      </button>
    </fieldset>
  );
}

function ListField({ name, value, required, onChange }: { name: string; value: string[]; required: boolean; onChange: (v: string[]) => void }) {
  const { t } = useLanguage();
  return (
    <fieldset>
      <legend>
        {t(label(name))}
        {!required && <span className="muted">{t(" (optional)")}</span>}
      </legend>
      {value.map((item, i) => (
        <div className="row" key={i}>
          <input data-variable-target aria-label={t("{field} {number}", { field: t(label(name)), number: i + 1 })} value={item} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} />
          <button type="button" className="quiet" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t("Remove {field} {number}", { field: t(label(name)), number: i + 1 })}>{t("Remove")}</button>
        </div>
      ))}
      <button type="button" className="quiet" onClick={() => onChange([...value, ""])}>{t("Add item")}</button>
    </fieldset>
  );
}
