import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";

export type Resource = { id: string; name: string; active: boolean; createdAt: string };

/**
 * The owner's resources: the therapists, rooms or tables a resource field offers (decision 0031). Archived ones leave
 * the forms but keep their id, so past runs still point at them.
 */
export function ResourcesPage() {
  const [list, setList] = useState<Resource[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  // Only the newest list request may set the list, so a slow first load cannot hide a resource added after it.
  const latest = useRef(0);
  const load = () => {
    const n = ++latest.current;
    return api<Resource[]>("GET", "/resources").then(
      (rows) => n === latest.current && setList(rows),
      (e: Error) => setError(e.message),
    );
  };
  useEffect(() => {
    load();
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await api("POST", "/resources", { name });
      setName("");
    });
  };
  const rename = (r: Resource) => {
    const next = prompt(`New name for ${r.name}. Runs already started keep the old name.`, r.name);
    if (next && next !== r.name) return run(() => api("PATCH", `/resources/${r.id}`, { name: next }));
  };

  return (
    <main className="page">
      <header className="toolbar plain">
        <a href="#/">Workflows</a>
        <h1>Resources</h1>
      </header>
      <p className="muted">People, rooms or tables a form can be booked for. Add a field of type resource to a form to let people choose one.</p>
      <form onSubmit={add} className="create">
        <div className="row">
          <div className="field">
            <label htmlFor="resource-name">Name</label>
            <input id="resource-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          </div>
          <button className="primary">Add resource</button>
        </div>
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
      </form>
      {list === null ? (
        <p>Loading…</p>
      ) : list.length === 0 ? (
        <p>No resources yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.active ? "Active" : "Archived"}</td>
                  <td>
                    <button type="button" className="quiet" onClick={() => rename(r)}>
                      Rename
                    </button>
                    <button type="button" className="quiet" onClick={() => run(() => api("PATCH", `/resources/${r.id}`, { active: !r.active }))}>
                      {r.active ? "Archive" : "Restore"}
                    </button>
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
