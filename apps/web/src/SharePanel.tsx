import { useState } from "react";
import type { FormField, Trigger } from "@daloy/engine";
import { FormEmbed } from "./FormEmbed";
import { useLanguage } from "./Language";
import { Sheet } from "./Sheet";

/** What the Share sheet needs: the workflow slug, the published trigger, its row id (the form link) and its webhook path. */
export type ShareInfo = { slug: string; live: Trigger | null; triggerId: string | null; webhookPath: string | null };

/** Triggers that someone outside Daloy can start, so the editor offers Share for them (T5). */
export const shareable = (type: string) => type === "form" || type === "webhook";

/** A read-only value with a Copy button. A refused clipboard leaves the field selected so it can be copied by hand. */
function Copyable({ label, value, rows }: { label: string; value: string; rows?: number }) {
  const { t } = useLanguage();
  const [state, setState] = useState<"copied" | "manual" | null>(null);
  const copy = () => navigator.clipboard.writeText(value).then(() => setState("copied"), () => setState("manual"));
  return (
    <div className="field share-copy">
      <label>
        {label}
        {rows ? <textarea readOnly rows={rows} value={value} onFocus={(e) => e.target.select()} spellCheck={false} /> : <input readOnly value={value} onFocus={(e) => e.target.select()} />}
      </label>
      <button type="button" className="quiet" onClick={() => void copy()} aria-label={t("Copy {what}", { what: label })}>{t("Copy")}</button>
      {state === "copied" && <span role="status">{t("Copied.")}</span>}
      {state === "manual" && <span role="status">{t("Copy failed. Select the text and copy it yourself.")}</span>}
    </div>
  );
}

/** Sample JSON for a webhook call: the listed fields with placeholder values, or one example key. */
export function webhookSample(fields: FormField[] | undefined): string {
  if (!fields?.length) return JSON.stringify({ event: "test" });
  return JSON.stringify(Object.fromEntries(fields.map((f) => [f.name, f.type === "number" ? 1 : f.type === "email" ? "ana@example.com" : f.label])));
}

/** One sheet with every way to start this workflow from outside: form link and embed, MCP tool, webhook URL and a curl call. */
export function ShareSheet({ info, onClose }: { info: ShareInfo; onClose: () => void }) {
  const { t } = useLanguage();
  const live = info.live;
  return (
    <Sheet title={t("Share")} onClose={onClose}>
      {!live || !shareable(live.type) ? (
        <p className="wk-sheet-text">{t("Publish first. Links here start the published version, so there is nothing to share until then.")}</p>
      ) : live.type === "form" ? (
        <FormShare slug={info.slug} formLink={`${location.origin}/forms/${info.triggerId ?? ""}`} />
      ) : (
        <WebhookShare url={`${location.origin}/hooks/${info.webhookPath ?? ""}`} config={live.config} />
      )}
      <div className="wk-sheet-actions">
        <button type="button" className="wk-button blue" onClick={onClose}>{t("Done")}</button>
      </div>
    </Sheet>
  );
}

function FormShare({ slug, formLink }: { slug: string; formLink: string }) {
  const { t } = useLanguage();
  return (
    <>
      <h3>{t("Form link")}</h3>
      <p className="wk-sheet-text">{t("Anyone with the link can fill in the form. Each answer starts a run.")}</p>
      <Copyable label={t("Form link")} value={formLink} />
      <p>
        <a href={formLink} target="_blank" rel="noreferrer">{t("Open the form")}</a>
      </p>
      <h3>{t("On your website")}</h3>
      <div className="actions">
        <FormEmbed link={formLink} />
      </div>
      <h3>{t("AI assistants (MCP)")}</h3>
      <p className="wk-sheet-text">{t("An MCP client such as Claude Desktop can start this automation as the tool {tool}. It needs an API token with Run access.", { tool: slug })}</p>
      <Copyable label={t("MCP server")} value={`${location.origin}/mcp`} />
      <p>
        <a href="#/tokens">{t("API tokens")}</a>
      </p>
    </>
  );
}

function WebhookShare({ url, config }: { url: string; config: Record<string, unknown> }) {
  const { t } = useLanguage();
  const secret = typeof config.hmacSecret === "string" ? config.hmacSecret : null;
  const body = webhookSample(config.fields as FormField[] | undefined);
  const curl = secret
    ? `BODY='${body}'\nTS=$(date +%s)\nSIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')\ncurl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -H "X-Daloy-Timestamp: $TS" \\\n  -H "X-Daloy-Signature: sha256=$SIG" \\\n  -d "$BODY"`
    : `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${body}'`;
  return (
    <>
      <h3>{t("Webhook URL")}</h3>
      <Copyable label={t("Webhook URL")} value={url} />
      <p className="wk-sheet-text">
        {secret
          ? t("Calls must be signed with the secret {name}: X-Daloy-Signature is sha256= and the hex HMAC-SHA256 of the timestamp, a dot and the raw body, with X-Daloy-Timestamp in unix seconds. Unsigned calls are refused.", { name: secret })
          : t("Anyone with this URL can start a run. Add a signing secret in the trigger settings to refuse other callers.")}
      </p>
      <h3>{t("Try it from a terminal")}</h3>
      <Copyable label={t("curl example")} value={curl} rows={secret ? 8 : 3} />
      {secret && <p className="muted hint">{t("Set SECRET to the value of {name} first. Never paste the secret into a shared chat.", { name: secret })}</p>}
    </>
  );
}
