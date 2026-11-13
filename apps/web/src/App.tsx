import { TEMPLATES } from "@daloy/engine";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Workflow } from "./api";
import { Editor } from "./Editor";
import { RunPage, RunsPage } from "./Runs";
import { BuildWithAi } from "./AiDraft";
import { SettingsPage } from "./Settings";
import { TokensPage } from "./Tokens";
import { VersionsPage } from "./Versions";

type User = { id: string; email: string };

/**
 * Hash routes (#/, #/w/<id>, #/w/<id>/runs, #/w/<id>/versions, #/runs/<id>, #/tokens, #/settings),
 * so no path of the console can clash with an API route on the same origin.
 */
function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const hash = useHash();
  useEffect(() => {
    api<User>("GET", "/auth/me").then(setUser, () => setUser(null));
  }, []);

  if (user === undefined) return <main className="page" />;
  if (!user) return <SignIn onDone={setUser} />;
  const page = /^#\/w\/([0-9a-f-]{36})(?:\/(runs|versions))?$/.exec(hash);
  if (page?.[2] === "runs") return <RunsPage key={page[1]} workflowId={page[1]!} />;
  if (page?.[2] === "versions") return <VersionsPage key={page[1]} workflowId={page[1]!} />;
  if (page) return <Editor key={page[1]} id={page[1]!} />;
  const run = /^#\/runs\/([0-9a-f-]{36})$/.exec(hash);
  if (run) return <RunPage key={run[1]} runId={run[1]!} />;
  if (hash === "#/tokens") return <TokensPage />;
  if (hash === "#/settings") return <SettingsPage />;
  return <Workflows user={user} onSignOut={() => api("POST", "/auth/logout").then(() => setUser(null))} />;
}

function SignIn({ onDone }: { onDone: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      onDone(await api<User>("POST", `/auth/${mode}`, { email: form.get("email"), password: form.get("password") }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <main className="page narrow">
      <h1 className="brand">
        <img src="/logo.svg" alt="" width="32" height="32" />
        Daloy
      </h1>
      <p className="muted">Build workflows from a trigger and a series of steps.</p>
      <form onSubmit={submit}>
        <h2>{mode === "login" ? "Sign in" : "Create an account"}</h2>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="field">
          <label htmlFor="password">Password {mode === "register" && <span className="muted">(at least 12 characters)</span>}</label>
          <input id="password" name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required />
        </div>
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
        <div className="actions">
          <button className="primary">{mode === "login" ? "Sign in" : "Create account"}</button>
          <button type="button" className="quiet" onClick={() => (setMode(mode === "login" ? "register" : "login"), setError(""))}>
            {mode === "login" ? "Create an account instead" : "I have an account"}
          </button>
        </div>
      </form>
    </main>
  );
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

function Workflows({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [list, setList] = useState<Workflow[] | null>(null);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    api<Workflow[]>("GET", "/workflows").then(setList, (e: Error) => setError(e.message));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const wf = await api<Workflow>("POST", "/workflows", { name, slug: slugify(name) || "workflow" });
      const t = TEMPLATES.find((t) => t.slug === template);
      if (t) await api("POST", `/workflows/${wf.id}/versions`, { definition: t.definition, publish: false });
      location.hash = `#/w/${wf.id}`;
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "A workflow with that name already exists." : (err as Error).message);
    }
  };

  return (
    <main className="page">
      <header className="toolbar plain">
        <img src="/logo.svg" alt="Daloy" width="28" height="28" />
        <h1>Workflows</h1>
        <span className="muted">{user.email}</span>
        <a href="#/tokens">API tokens</a>
        <a href="#/settings">AI model</a>
        <button type="button" className="quiet" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <form onSubmit={create} className="create">
        <h2>New workflow</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="wf-name">Name</label>
            <input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="wf-template">Start from</label>
            <select id="wf-template" value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="">Blank workflow</option>
              {TEMPLATES.map((t) => (
                <option key={t.slug} value={t.slug}>
                  Template: {t.name}
                </option>
              ))}
            </select>
          </div>
          <button className="primary">Create</button>
        </div>
        {template && <p className="muted hint">{TEMPLATES.find((t) => t.slug === template)!.description}</p>}
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
      </form>
      <BuildWithAi />
      <h2>Your workflows</h2>
      {list === null ? (
        <p>Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="list">
          {list.map((w) => (
            <li key={w.id}>
              <a href={`#/w/${w.id}`}>{w.name}</a> <span className="muted">{w.slug}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
