import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

type Token = { id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

/** API tokens for MCP clients. The API returns a new token once; only its hash is stored. */
export function TokensPage() {
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
  const revoke = async (t: Token) => {
    if (!confirm(`Revoke "${t.name}"? Clients using it stop working.`)) return;
    setError("");
    try {
      await api("DELETE", `/tokens/${t.id}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="page">
      <header className="toolbar plain">
        <a href="#/">Workflows</a>
        <h1>API tokens</h1>
      </header>
      <p>
        MCP clients connect to <code>{location.origin}/mcp</code> with <code>Authorization: Bearer &lt;token&gt;</code>. Each published workflow with a form
        trigger is a tool, plus <code>get_run_status</code>.
      </p>
      <form onSubmit={create} className="create">
        <h2>New token</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="token-name">Name</label>
            <input id="token-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="Claude Desktop" />
          </div>
          <button className="primary">Create token</button>
        </div>
        {created && (
          <div role="status">
            <p className="message ok">Copy the token for {created.name} now. It is not shown again.</p>
            <pre className="token" aria-label="New token">
              {created.token}
            </pre>
          </div>
        )}
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
      </form>
      <h2>Your tokens</h2>
      {list === null ? (
        <p>Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{when(t.createdAt)}</td>
                  <td>{when(t.lastUsedAt)}</td>
                  <td>
                    {t.revokedAt ? (
                      <span className="muted">Revoked {when(t.revokedAt)}</span>
                    ) : (
                      <button type="button" onClick={() => revoke(t)} aria-label={`Revoke ${t.name}`}>
                        Revoke
                      </button>
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
