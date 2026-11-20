import "./workspace.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { useLanguage } from "./Language";
import { countActiveTokens, isToday, shortDate, shortTime, tokenStatus } from "./lib/advanced";
import { ConfirmSheet, Sheet, usePhone } from "./Sheet";

type Token = { id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; scopes: string[]; expiresAt: string | null };
type Created = { id: string; name: string; token: string; scopes: string[]; expiresAt: string | null };

const SCOPES = [
  { id: "read", label: "Read runs and bookings" },
  { id: "run", label: "Start workflows" },
  { id: "manage", label: "Resolve runs and change bookings" },
];
const EXPIRY = [
  { days: "", label: "Never" },
  { days: "7", label: "7 days" },
  { days: "30", label: "30 days" },
  { days: "90", label: "90 days" },
  { days: "365", label: "365 days" },
];

/** API tokens for MCP clients (Doop row W8). The API returns a new token once; only its hash is stored. */
export function TokensPage() {
  const { t } = useLanguage();
  const phone = usePhone();
  const [list, setList] = useState<Token[] | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"new" | Token | null>(null);
  const tokenBox = useRef<HTMLPreElement>(null);
  const load = () => api<Token[]>("GET", "/tokens").then(setList, (e: Error) => setError(e.message));
  const scopeText = (ids: string[]) => ids.map((id) => t(SCOPES.find((s) => s.id === id)?.label ?? id)).join(", ");
  const expiry = (iso: string | null | undefined) => (!iso ? t("Never expires") : new Date(iso) < new Date() ? t("Expired") : t("Expires {date}", { date: new Date(iso).toLocaleDateString() }));
  const used = (iso: string | null) => (!iso ? t("never") : isToday(iso) ? t("Today, {time}", { time: shortTime(iso) }) : shortDate(iso));
  useEffect(() => {
    load();
  }, []);

  const revoke = async (token: Token) => {
    setError("");
    try {
      await api("DELETE", `/tokens/${token.id}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setDialog(null);
  };
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(t("Copied"));
    } catch {
      // No clipboard permission (for example on plain http): select the text so Ctrl+C works.
      const box = tokenBox.current;
      if (box) getSelection()?.selectAllChildren(box);
      setCopied(t("Select the token and copy it with Ctrl+C."));
    }
  };

  const active = list ? countActiveTokens(list) : null;
  return (
    <main className="page wk wk-tokens">
      <header className="wk-head">
        <div>
          <a className="wk-back" href="#/advanced">{t("Advanced")}</a>
          <div className="wk-title-row">
            <h1>{t("API tokens")}</h1>
            {active !== null && <span className="wk-sub">{t("{count} active", { count: active })}</span>}
          </div>
        </div>
        {phone && <button type="button" className="wk-button blue wk-head-action" onClick={() => setDialog("new")}>{t("New token")}</button>}
      </header>
      <p className="wk-lead wk-narrow-text">{t("MCP clients connect to ")}<code>{location.origin}/mcp</code>{t(" with ")}<code>Authorization: Bearer &lt;token&gt;</code>{t(". What a token can do depends on its access, chosen below.")}</p>
      {!phone && (
        <section className="wk-card" aria-label={t("Create a token")}>
          <div className="wk-body">
            <h2 className="wk-card-title">{t("New token")}</h2>
            <NewTokenForm onCreated={(made) => { setCreated(made); setCopied(""); void load(); }} />
          </div>
        </section>
      )}
      <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
      {created && (
        <section role="status" className="wk-card wk-created">
          <div className="wk-body">
            <h2 className="wk-card-title">{t("Token created for {name}", { name: created.name })}</h2>
            <p><b>{t("Copy the token now. You will not see it again.")}</b> {t("Daloy keeps only a hash, so a lost token cannot be recovered. Create a new one instead.")}</p>
            <div className="wk-copyrow">
              <pre className="wk-token" ref={tokenBox} aria-label={t("New token")}>{created.token}</pre>
              <button type="button" className="wk-button blue" onClick={() => void copy()}>{t("Copy token")}</button>
            </div>
            <p className="wk-muted">{t("Access: {scopes}. {expiry}.", { scopes: scopeText(created.scopes), expiry: expiry(created.expiresAt) })}</p>
            {copied && <p className="wk-muted wk-copied">{copied}</p>}
          </div>
        </section>
      )}
      <section className="wk-card" aria-label={t("Your tokens")}>
        <h2 className="wk-card-head"><b>{t("Your tokens")}</b><span>{t("The token value is never shown again after it is created.")}</span></h2>
        {list === null ? (
          <p className="wk-body wk-sub" role="status">{t("Loading…")}</p>
        ) : list.length === 0 ? (
          <p className="wk-body wk-sub">{t("None yet.")}</p>
        ) : (
          <table className="wk-table wk-token-table">
            <thead>
              <tr>
                <th scope="col">{t("Name")}</th>
                <th scope="col">{t("Created")}</th>
                <th scope="col">{t("Last used")}</th>
                <th scope="col">{t("Access")}</th>
                <th scope="col">{t("Expires")}</th>
                <th scope="col">{t("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((token) => {
                const status = tokenStatus(token);
                return (
                  <tr key={token.id} className={`${status === "revoked" ? "off" : ""}${created?.id === token.id ? " fresh" : ""}`}>
                    <td className="wk-name">{token.name}</td>
                    <td className="wk-when" data-label={t("Created")}>{shortDate(token.createdAt)}</td>
                    <td data-label={t("Last used")}>{used(token.lastUsedAt)}</td>
                    <td data-label={t("Access")}>{scopeText(token.scopes)}</td>
                    <td data-label={t("Expires")} className={status === "expired" ? "wk-bad" : undefined}>{expiry(token.expiresAt)}</td>
                    <td className="wk-status">
                      <span className={`wk-pill ${status === "active" ? "ok" : status === "expired" ? "red" : ""}`}>{t(status === "active" ? "Active" : status === "expired" ? "Expired" : "Revoked")}</span>
                      {token.revokedAt ? (
                        <span className="wk-muted">{shortDate(token.revokedAt)}</span>
                      ) : (
                        <button type="button" className="wk-button" onClick={() => setDialog(token)} aria-label={t("Revoke {name}", { name: token.name })}>{t("Revoke")}</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      {dialog === "new" && (
        <Sheet title={t("New token")} onClose={() => setDialog(null)}>
          <NewTokenForm onCreated={(made) => { setCreated(made); setCopied(""); setDialog(null); void load(); }} onCancel={() => setDialog(null)} />
        </Sheet>
      )}
      {dialog && dialog !== "new" && (
        <ConfirmSheet
          title={t('Revoke "{name}"?', { name: dialog.name })}
          text={t("Clients using it stop working, and a revoked token cannot be turned back on.")}
          confirm={t("Revoke")}
          cancel={t("Cancel")}
          danger
          onConfirm={() => void revoke(dialog)}
          onClose={() => setDialog(null)}
        />
      )}
    </main>
  );
}

function NewTokenForm({ onCreated, onCancel }: { onCreated: (made: Created) => void; onCancel?: () => void }) {
  const { t } = useLanguage();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState(["read", "run"]);
  const [days, setDays] = useState("90");
  const [error, setError] = useState("");
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (scopes.length === 0) return setError(t("Pick at least one kind of access."));
    try {
      const made = await api<Created>("POST", "/tokens", { name, scopes, ...(days ? { expiresInDays: Number(days) } : {}) });
      setName("");
      onCreated(made);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form onSubmit={create} className="wk-token-form wk-fields">
      <div className="wk-token-row">
        <div>
          <label htmlFor="token-name">{t("Name")}</label>
          <input id="token-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="Claude Desktop" />
        </div>
        <div>
          <label htmlFor="token-expiry">{t("Expires")}</label>
          <select id="token-expiry" value={days} onChange={(e) => setDays(e.target.value)}>
            {EXPIRY.map((o) => (
              <option key={o.days} value={o.days}>{t(o.label)}</option>
            ))}
          </select>
        </div>
        <button className="wk-button blue">{t("Create token")}</button>
        {onCancel && <button type="button" className="wk-button wk-cancel" onClick={onCancel}>{t("Cancel")}</button>}
      </div>
      <fieldset className="wk-access">
        <legend>{t("Access")}</legend>
        {SCOPES.map((scope) => (
          <label key={scope.id}>
            <input type="checkbox" checked={scopes.includes(scope.id)} onChange={(e) => setScopes(e.target.checked ? [...scopes, scope.id] : scopes.filter((x) => x !== scope.id))} />
            {t(scope.label)}
          </label>
        ))}
      </fieldset>
      <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
    </form>
  );
}
