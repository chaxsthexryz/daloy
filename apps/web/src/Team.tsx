import "./request-access.css";
import "./workspace-admin.css";
import "./workspace.css";
import { Text, useLanguage } from "./Language";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { AuthLayout, AuthNote, Brand } from "./AuthLayout";
import { Sheet, usePhone } from "./Sheet";
import { checkNewPassword } from "./lib/password";
import { requestStatus, sentOn } from "./lib/my-requests";
import { canChangeRole, canInvite, canRemove, groupMembers, memberRoles, type Member, type MemberRole, type Role } from "./lib/team";

export type { Role };
export type User = { id: string; email: string; workspaceId: string; role: Role; language?: "en" | "tl"; ask?: boolean; admin?: boolean };

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", operator: "Operator", approver: "Approver", requester: "Requester" };
const GROUP_LABEL: Record<Role, string> = { owner: "Owner", operator: "Operators", approver: "Approvers", requester: "Requesters" };
const ROLE_HELP: Record<Role, string> = {
  owner: "Runs the workspace. Only the owner invites, changes roles and removes people.",
  operator: "See automations, runs and requests, and retry deliveries.",
  approver: "Answer approvals that name them.",
  requester: "Send requests and follow their own.",
};
const joined = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

type Invite = { email: string; link: string };

/** The invite form and, once a link exists, the link to send. Nothing is emailed (decision 0022). */
function InviteForm({ onDone }: { onDone?: () => void }) {
  const { t } = useLanguage();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("approver");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setCopied(false);
    try {
      setInvite(await api<Invite>("POST", "/workspace/invites", { email, role }));
      setEmail("");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const copy = () => {
    void navigator.clipboard?.writeText(invite!.link);
    setCopied(true);
  };
  return (
    <form onSubmit={send} className="wk-invite">
      <div className="wk-invite-row">
        <input id="invite-email" type="email" aria-label={t("Email")} placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />
        <select id="invite-role" aria-label={t("Role")} value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
          {memberRoles.map((r) => (
            <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>
          ))}
        </select>
        <button className="wk-button blue">{t("Create invite link")}</button>
      </div>
      {invite && (
        <div role="status" className="wk-note ok">
          <p>
            <b>{t("Send this link to {email}.", { email: invite.email })}</b> {t("It works once and expires in seven days.")}
          </p>
          <code aria-label={t("Invite link")}>{invite.link}</code>
          <button type="button" className="wk-button" onClick={copy}>{copied ? t("Copied") : t("Copy link")}</button>
        </div>
      )}
      <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
      {onDone && <button type="button" className="wk-button wk-sheet-cancel" onClick={onDone}>{t("Close")}</button>}
    </form>
  );
}

type Dialog = { kind: "invite" } | { kind: "role"; member: Member } | { kind: "remove"; member: Member };

/** The owner's Team page: who is in the workspace, grouped by role, with invite links (decision 0022). */
export function TeamPage({ user }: { user: User }) {
  const { t } = useLanguage();
  const phone = usePhone();
  const [list, setList] = useState<Member[] | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
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
    setDialog(null);
  };
  const actor = user.role;
  const groups = groupMembers(list ?? []);

  return (
    <main className="page wk wk-team">
      <header className="wk-head">
        <div>
          <div className="wk-title-row">
            <h1>{t("Team")}</h1>
            {list && <span className="wk-sub">{list.length === 1 ? t("1 member") : t("{count} members", { count: list.length })}</span>}
          </div>
        </div>
        {phone && canInvite(actor) && <button type="button" className="wk-button blue wk-head-action" onClick={() => setDialog({ kind: "invite" })}>{t("Invite")}</button>}
      </header>
      {!phone && canInvite(actor) && (
        <section className="wk-card" aria-labelledby="invite-heading">
          <div className="wk-body">
            <h2 id="invite-heading" className="wk-card-title">{t("Invite someone")}</h2>
            <InviteForm />
          </div>
        </section>
      )}
      <p role="alert" className="wk-note bad" hidden={!error}>{error}</p>
      {list === null ? (
        <p className="wk-sub">{t("Loading…")}</p>
      ) : (
        groups.map(({ role, members }) => (
          <section key={role} className="wk-card wk-group" aria-labelledby={`group-${role}`}>
            <h2 className="wk-card-head" id={`group-${role}`}>
              <b>{role === "owner" ? t(GROUP_LABEL[role]) : `${t(GROUP_LABEL[role])} · ${members.length}`}</b>
              <span>{t(ROLE_HELP[role])}</span>
            </h2>
            <ul className="wk-rows">
              {members.map((m) => (
                <li key={m.userId} className="wk-row">
                  <span className="wk-email">{m.email}</span>
                  <small>{t("Joined {date}", { date: joined(m.createdAt) })}</small>
                  {m.role === "owner" ? (
                    <span className="wk-chip">{t("Owner")}</span>
                  ) : (
                    <>
                      {canChangeRole(actor, m) && (
                        <button type="button" className="wk-button wk-role" aria-label={t("Change role of {email}", { email: m.email })} onClick={() => setDialog({ kind: "role", member: m })}>
                          {phone ? t(ROLE_LABEL[m.role]) : t("Change role")}
                        </button>
                      )}
                      {canRemove(actor, m) && !phone && (
                        <button type="button" className="wk-button" aria-label={t("Remove {name}", { name: m.email })} onClick={() => setDialog({ kind: "remove", member: m })}>{t("Remove")}</button>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {dialog?.kind === "invite" && (
        <Sheet title={t("Invite someone")} onClose={() => setDialog(null)}>
          <InviteForm onDone={() => setDialog(null)} />
        </Sheet>
      )}
      {dialog?.kind === "role" && <RoleSheet member={dialog.member} phone={phone} onClose={() => setDialog(null)} onSave={(role) => run(() => api("PATCH", `/workspace/members/${dialog.member.userId}`, { role }))} onRemove={() => setDialog({ kind: "remove", member: dialog.member })} />}
      {dialog?.kind === "remove" && (
        <Sheet title={t("Remove {email}?", { email: dialog.member.email })} onClose={() => setDialog(null)}>
          <p className="wk-sheet-text">{t("They are signed out, and approvals that name them can no longer be answered.")}</p>
          <div className="wk-sheet-actions">
            <button type="button" className="wk-button danger" onClick={() => run(() => api("DELETE", `/workspace/members/${dialog.member.userId}`))}>{t("Remove")}</button>
            <button type="button" className="wk-button" onClick={() => setDialog(null)}>{t("Cancel")}</button>
          </div>
        </Sheet>
      )}
    </main>
  );
}

function RoleSheet({ member, phone, onClose, onSave, onRemove }: { member: Member; phone: boolean; onClose: () => void; onSave: (role: MemberRole) => void; onRemove: () => void }) {
  const { t } = useLanguage();
  const [role, setRole] = useState<MemberRole>(member.role as MemberRole);
  return (
    <Sheet title={t("Change role of {email}", { email: member.email })} onClose={onClose}>
      <fieldset className="wk-roles">
        <legend className="wk-sr">{t("Role")}</legend>
        {memberRoles.map((r) => (
          <label key={r} className="wk-radio">
            <input type="radio" name="member-role" value={r} checked={role === r} onChange={() => setRole(r)} />
            <span><b>{t(ROLE_LABEL[r])}</b> <small>{t(ROLE_HELP[r])}</small></span>
          </label>
        ))}
      </fieldset>
      <div className="wk-sheet-actions">
        <button type="button" className="wk-button blue" onClick={() => onSave(role)}>{t("Save")}</button>
        <button type="button" className="wk-button" onClick={onClose}>{t("Cancel")}</button>
        {phone && <button type="button" className="wk-button danger-quiet" onClick={onRemove}>{t("Remove {name}", { name: member.email })}</button>}
      </div>
    </Sheet>
  );
}

/** The page behind an invite link (Doop row E5). A new person sets a password; someone with an account in no workspace enters theirs. */
export function AcceptInvitePage({ token, onDone }: { token: string; onDone: (u: User) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password"));
    // The API holds the same limits for a new and an existing account, so they are checked first.
    const issue = checkNewPassword(password);
    if (issue) return setError(issue === "too-short" ? "Password must be at least 12 characters." : "Password can have at most 200 characters.");
    setError("");
    setBusy(true);
    try {
      const user = await api<User>("POST", `/auth/invites/${token}/accept`, { password });
      location.hash = "#/";
      onDone(user);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <AuthLayout title="Join your team">
      <p className="au-lead">Choose a password for your account. If this email already has a kymavo account, enter its password.</p>
      <form onSubmit={submit} className="au-fields">
        <div className="au-field">
          <div className="au-label-row"><label htmlFor="invite-password">Password <span>(at least 12 characters)</span></label></div>
          <input id="invite-password" name="password" type="password" autoComplete="new-password" placeholder="Password" required aria-invalid={!!error} aria-describedby={error ? "invite-error" : undefined} />
          {error && <AuthNote kind="error" id="invite-error">{error}</AuthNote>}
        </div>
        <button className="au-button" disabled={busy}>Join</button>
      </form>
    </AuthLayout>
  );
}

type MyRequest = { reference: string; subject: string; createdAt: string; automation: string; state: string };

/** The home page of approvers and requesters (Doop row E6): requests they sent while signed in. */
export function MyRequestsPage({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const { t, language } = useLanguage();
  const [list, setList] = useState<MyRequest[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<MyRequest[]>("GET", "/my/requests").then(setList, (e: Error) => setError(e.message));
  }, []);
  return (
    <div className="mr">
      <header className="mr-bar">
        <Brand dark={false} />
        <span className="mr-who">
          {user.email} ({t(user.role)})
        </span>
        <a href="#/account">{t("Account")}</a>
        <button type="button" className="mr-out" onClick={onSignOut}>{t("Sign out")}</button>
      </header>
      <main className="mr-body motion-page">
        <h1>{t("My requests")}</h1>
        {user.role === "approver" && <p className="mr-approver">{t("Approval requests come to your email. Open the link while signed in as {email} to answer.", { email: user.email })}</p>}
        <p className="mr-sub">{t("Requests you send through your office's request form while signed in show up here.")}</p>
        <p role="alert" className="au-note error" hidden={!error}>
          {error}
        </p>
        <div className="mr-card">
          {list === null ? (
            error ? null : <p className="mr-empty">{t("Loading…")}</p>
          ) : list.length === 0 ? (
            <p className="mr-empty">{t("None yet.")}</p>
          ) : (
            <table className="mr-table">
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
                {list.map((r) => {
                  const status = requestStatus(r.state);
                  return (
                    <tr key={r.reference}>
                      <td className="ref mr-ref">{r.reference}</td>
                      <td className="subject">{r.subject}</td>
                      <td className="automation">{r.automation}</td>
                      <td className="sent">{sentOn(r.createdAt, language)}</td>
                      <td className="status"><span className={`mr-pill ${status.kind}`}>{t(status.label)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}
