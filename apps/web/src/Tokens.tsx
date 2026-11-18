import "./workspace-admin.css";
import { Text, useLanguage } from "./Language";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

type Token = { id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; scopes: string[]; expiresAt: string | null };
type Created = { id: string; name: string; token: string; scopes: string[]; expiresAt: string | null };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");
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

/** API tokens for MCP clients. The API returns a new token once; only its hash is stored. */
export function TokensPage() {
  const { t } = useLanguage();
  const [list, setList] = useState<Token[] | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState(["read", "run"]);
  const [days, setDays] = useState("90");
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState("");
  const load = () => api<Token[]>("GET", "/tokens").then(setList, (e: Error) => setError(e.message));
  const scopeText = (ids: string[]) => ids.map((id) => t(SCOPES.find((s) => s.id === id)?.label ?? id)).join(", ");
  const expiry = (iso: string | null | undefined) => (!iso ? t("Never expires") : new Date(iso) < new Date() ? t("Expired") : t("Expires {date}", { date: new Date(iso).toLocaleDateString() }));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (scopes.length === 0) return setError(t("Pick at least one kind of access."));
    try {
      const made = await api<Created>("POST", "/tokens", { name, scopes, ...(days ? { expiresInDays: Number(days) } : {}) });
      setName("");
      setCreated(made);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const revoke = async (token: Token) => {
    if (!confirm(t('Revoke "{name}"? Clients using it stop working.', { name: token.name }))) return;
    setError("");
    try {
      await api("DELETE", `/tokens/${token.id}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="page workspace-admin admin-tokens">
      <header className="toolbar plain">
        <a href="#/advanced">{t("Advanced")}</a>
        <h1><Text>API tokens</Text></h1>
      </header>
      <p>{t("MCP clients connect to ")}<code>{location.origin}/mcp</code>{t(" with ")}<code>Authorization: Bearer &lt;token&gt;</code>{t(". What a token can do depends on its access, chosen below.")}</p>
      <form onSubmit={create} className="create">
        <h2>{t("New token")}</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="token-name"><Text>Name</Text></label>
            <input id="token-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="Claude Desktop" />
          </div>
          <button className="primary">{t("Create token")}</button>
        </div>
        <fieldset>
          <legend>{t("Access")}</legend>
          {SCOPES.map((scope) => (
            <label key={scope.id} className="check">
              <input type="checkbox" checked={scopes.includes(scope.id)} onChange={(e) => setScopes(e.target.checked ? [...scopes, scope.id] : scopes.filter((x) => x !== scope.id))} />
              {t(scope.label)}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="token-expiry">{t("Expires")}</label>
          <select id="token-expiry" value={days} onChange={(e) => setDays(e.target.value)}>
            {EXPIRY.map((o) => (
              <option key={o.days} value={o.days}>{t(o.label)}</option>
            ))}
          </select>
        </div>
        {created && (
          <div role="status">
            <p className="message ok">{t("Copy the token for {name} now. It is not shown again.", { name: created.name })}</p>
            <pre className="token" aria-label={t("New token")}>
              {created.token}
            </pre>
            <p className="muted">{t("Access: {scopes}. {expiry}.", { scopes: scopeText(created.scopes), expiry: expiry(created.expiresAt) })}</p>
          </div>
        )}
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
      </form>
      <h2>{t("Your tokens")}</h2>
      {list === null ? (
        <p><Text>Loading…</Text></p>
      ) : list.length === 0 ? (
        <p className="muted">{t("None yet.")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table cards admin-table">
            <thead>
              <tr>
                <th scope="col"><Text>Name</Text></th>
                <th scope="col">{t("Created")}</th>
                <th scope="col">{t("Last used")}</th>
                <th scope="col">{t("Access")}</th>
                <th scope="col">{t("Expires")}</th>
                <th scope="col"><Text>Status</Text></th>
              </tr>
            </thead>
            <tbody>
              {list.map((token) => (
                <tr key={token.id}>
                  <td data-label={t("Name")}>{token.name}</td>
                  <td data-label={t("Created")}>{when(token.createdAt)}</td>
                  <td data-label={t("Last used")}>{token.lastUsedAt ? when(token.lastUsedAt) : t("never")}</td>
                  <td data-label={t("Access")}>{scopeText(token.scopes)}</td>
                  <td data-label={t("Expires")}>{expiry(token.expiresAt)}</td>
                  <td data-label={t("Status")}>
                    {token.revokedAt ? (
                      <span className="muted">{t("Revoked ")}{when(token.revokedAt)}</span>
                    ) : (
                      <button type="button" onClick={() => revoke(token)} aria-label={t("Revoke {name}", { name: token.name })}>{t("Revoke")}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
