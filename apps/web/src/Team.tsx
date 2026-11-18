import { Text, useLanguage } from "./Language";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

export type Role = "owner" | "operator" | "approver" | "requester";
export type User = { id: string; email: string; workspaceId: string; role: Role; language?: "en" | "tl"; ask?: boolean };
type Member = { userId: string; email: string; role: Role; createdAt: string };

const ROLE_HELP: Record<Exclude<Role, "owner">, string> = {
  operator: "sees automations, runs and requests, and retries deliveries",
  approver: "answers approvals that name them",
  requester: "sends requests and follows their own",
};
const MEMBER_ROLES = Object.keys(ROLE_HELP) as Exclude<Role, "owner">[];

/** The owner's Team page: who is in the workspace, their roles, and invite links (decision 0022). */
export function TeamPage() {
  const { t } = useLanguage();
  const [list, setList] = useState<Member[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Exclude<Role, "owner">>("approver");
  const [invite, setInvite] = useState<{ email: string; link: string } | null>(null);
  const [error, setError] = useState("");
  const load = () => api<Member[]>("GET", "/workspace/members").then(setList, (e: Error) => setError(e.message));
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

  const send = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      setInvite(await api<{ email: string; link: string }>("POST", "/workspace/invites", { email, role }));
      setEmail("");
    });
  };
  const remove = (m: Member) => {
    if (!confirm(t("Remove {email}? They are signed out, and approvals that name them can no longer be answered.", { email: m.email }))) return;
    return run(() => api("DELETE", `/workspace/members/${m.userId}`));
  };

  return (
    <main className="page">
      <header className="toolbar plain">
        <h1><Text>Team</Text></h1>
      </header>
      <form onSubmit={send} className="create">
        <h2>{t("Invite someone")}</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="invite-email"><Text>Email</Text></label>
            <input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />
          </div>
          <div className="field">
            <label htmlFor="invite-role">{t("Role")}</label>
            <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, "owner">)}>
              {MEMBER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(r)}: {t(ROLE_HELP[r])}
                </option>
              ))}
            </select>
          </div>
          <button className="primary">{t("Create invite link")}</button>
        </div>
        {invite && (
          <div role="status">
            <p className="message ok">{t("Send this link to {email}. It works once and expires in seven days.", { email: invite.email })}</p>
            <pre className="token" aria-label={t("Invite link")}>
              {invite.link}
            </pre>
            <button type="button" onClick={() => navigator.clipboard?.writeText(invite.link)}>{t("Copy link")}</button>
          </div>
        )}
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
      </form>
      <h2>{t("Members")}</h2>
      {list === null ? (
        <p>{t("Loading…")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col"><Text>Email</Text></th>
                <th scope="col">{t("Role")}</th>
                <th scope="col">{t("Joined")}</th>
                <th scope="col">
                  <span className="sr-only"><Text>Actions</Text></span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.userId}>
                  <td>{m.email}</td>
                  <td>
                    {m.role === "owner" ? (
                      t("owner")
                    ) : (
                      <select aria-label={t("Role of {email}", { email: m.email })} value={m.role} onChange={(e) => run(() => api("PATCH", `/workspace/members/${m.userId}`, { role: e.target.value }))}>
                        {MEMBER_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>{new Date(m.createdAt).toLocaleDateString()}</td>
                  <td>
                    {m.role !== "owner" && (
                      <button type="button" onClick={() => remove(m)} aria-label={t("Remove {name}", { name: m.email })}>{t("Remove")}</button>
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

/** The page behind an invite link. A new person sets a password; someone with an account in no workspace enters theirs. */
export function AcceptInvitePage({ token, onDone }: { token: string; onDone: (u: User) => void }) {
  const { t } = useLanguage();
  const [error, setError] = useState("");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    try {
      const user = await api<User>("POST", `/auth/invites/${token}/accept`, { password: new FormData(e.currentTarget).get("password") });
      location.hash = "#/";
      onDone(user);
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
      <form onSubmit={submit}>
        <h2>{t("Join your team")}</h2>
        <p className="muted">{t("Choose a password for your account. If this email already has a Daloy account, enter its password.")}</p>
        <div className="field">
          <label htmlFor="invite-password">{t("Password ")}<span className="muted">{t("(at least 12 characters)")}</span>
          </label>
          <input id="invite-password" name="password" type="password" autoComplete="new-password" minLength={12} required />
        </div>
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
        <div className="actions">
          <button className="primary">{t("Join")}</button>
        </div>
      </form>
    </main>
  );
}

type MyRequest = { reference: string; subject: string; createdAt: string; automation: string; state: string };

/** The home page of approvers and requesters: requests they sent while signed in. */
export function MyRequestsPage({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const { t } = useLanguage();
  const [list, setList] = useState<MyRequest[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<MyRequest[]>("GET", "/my/requests").then(setList, (e: Error) => setError(e.message));
  }, []);
  return (
    <main className="page">
      <header className="toolbar plain">
        <img src="/logo.svg" alt="Daloy" width="28" height="28" />
        <h1>{t("My requests")}</h1>
        <span className="muted">
          {user.email} ({t(user.role)})
        </span>
        <a href="#/account">{t("Account")}</a>
        <button type="button" className="quiet" onClick={onSignOut}>{t("Sign out")}</button>
      </header>
      {user.role === "approver" && <p>{t("Approval requests come to your email. Open the link while signed in as {email} to answer.", { email: user.email })}</p>}
      <p className="muted">{t("Requests you send through your office's request form while signed in show up here.")}</p>
      <p role="alert" className="message error" hidden={!error}>
        {error}
      </p>
      {list === null ? (
        <p>{t("Loading…")}</p>
      ) : list.length === 0 ? (
        <p className="muted">{t("None yet.")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col"><Text>Reference</Text></th>
                <th scope="col">{t("Subject")}</th>
                <th scope="col">{t("Automation")}</th>
                <th scope="col">{t("Sent")}</th>
                <th scope="col"><Text>Status</Text></th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.reference}>
                  <td>{r.reference}</td>
                  <td>{r.subject}</td>
                  <td>{r.automation}</td>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>{t(r.state)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
