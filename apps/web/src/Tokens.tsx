import { Text, useLanguage } from "./Language";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

type Token = { id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

/** API tokens for MCP clients. The API returns a new token once; only its hash is stored. */
export function TokensPage() {
  const { t } = useLanguage();
  const [list, setList] = useState<Token[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState("");
  const load = () => api<Token[]>("GET", "/tokens").then(setList, (e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      setCreated(await api<{ name: string; token: string }>("POST", "/tokens", { name }));
      setName("");
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
    <main className="page">
      <header className="toolbar plain">
        <a href="#/advanced">{t("Advanced")}</a>
        <h1><Text>API tokens</Text></h1>
      </header>
      <p>{t("MCP clients connect to ")}<code>{location.origin}/mcp</code>{t(" with ")}<code>Authorization: Bearer &lt;token&gt;</code>{t(". Each published workflow with a form trigger is a tool, plus ")}<code>get_run_status</code>.
      </p>
      <form onSubmit={create} className="create">
        <h2>{t("New token")}</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="token-name"><Text>Name</Text></label>
            <input id="token-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="Claude Desktop" />
          </div>
          <button className="primary">{t("Create token")}</button>
        </div>
        {created && (
          <div role="status">
            <p className="message ok">{t("Copy the token for {name} now. It is not shown again.", { name: created.name })}</p>
            <pre className="token" aria-label={t("New token")}>
              {created.token}
            </pre>
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
          <table className="table">
            <thead>
              <tr>
                <th scope="col"><Text>Name</Text></th>
                <th scope="col">{t("Created")}</th>
                <th scope="col">{t("Last used")}</th>
                <th scope="col"><Text>Status</Text></th>
              </tr>
            </thead>
            <tbody>
              {list.map((token) => (
                <tr key={token.id}>
                  <td>{token.name}</td>
                  <td>{when(token.createdAt)}</td>
                  <td>{token.lastUsedAt ? when(token.lastUsedAt) : t("never")}</td>
                  <td>
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
