import "./workspace-admin.css";
import "./workspace.css";
import { Breadcrumb } from "./Breadcrumb";
import { useState, type FormEvent } from "react";
import { api } from "./api";
import { ROLE_LABEL, type User } from "./Team";
import { useLanguage } from "./Language";
import { AuthLayout, AuthNote } from "./AuthLayout";
import { checkNewPassword, checkPasswordChange, type PasswordIssue } from "./lib/password";

/** Pre-login, so plain English like the sign-in page. Always the same answer, whether or not the account exists. */
export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("POST", "/auth/password-reset", { email: new FormData(e.currentTarget).get("email") });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return (
    <AuthLayout title="Forgot your password?">
      {sent ? (
        <AuthNote kind="ok">If an account exists for that email, we sent a link to set a new password. It works once, for 30 minutes.</AuthNote>
      ) : (
        <form onSubmit={submit} className="au-fields">
          <div className="au-field">
            <div className="au-label-row"><label htmlFor="forgot-email">Email</label></div>
            <input id="forgot-email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required aria-invalid={!!error} aria-describedby={error ? "forgot-error" : undefined} />
            {error && <AuthNote kind="error" id="forgot-error">{error}</AuthNote>}
          </div>
          <button className="au-button" disabled={busy}>Send link</button>
        </form>
      )}
      <p className="au-aside"><a className="au-link" href="#/">Back to sign in</a></p>
    </AuthLayout>
  );
}

/** The page behind the link in the reset email. An expired or used link shows the API's message beside the field. */
export function ResetPasswordPage({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password"));
    const issue = checkNewPassword(password);
    if (issue) return setError(issue === "too-short" ? "Password must be at least 12 characters." : "Password can have at most 200 characters.");
    setError("");
    setBusy(true);
    try {
      await api("POST", `/auth/password-reset/${token}`, { password });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return (
    <AuthLayout title="Set a new password">
      {done ? (
        <>
          <AuthNote kind="ok">Password changed. Sign in with your new password.</AuthNote>
          <p className="au-aside"><a className="au-link" href="#/">Sign in</a></p>
        </>
      ) : (
        <>
          <form onSubmit={submit} className="au-fields">
            <div className="au-field">
              <div className="au-label-row"><label htmlFor="reset-password">New password <span>(at least 12 characters)</span></label></div>
              <input id="reset-password" name="password" type="password" autoComplete="new-password" placeholder="New password" required aria-invalid={!!error} aria-describedby={error ? "reset-error" : undefined} />
              {error && <AuthNote kind="error" id="reset-error">{error}</AuthNote>}
            </div>
            <button className="au-button" disabled={busy}>Change password</button>
          </form>
          <p className="au-aside"><a className="au-link" href="#/forgot-password">Send a new link</a></p>
        </>
      )}
    </AuthLayout>
  );
}

const ISSUES: Record<PasswordIssue, { field: "currentPassword" | "newPassword"; message: string }> = {
  "current-required": { field: "currentPassword", message: "Enter your current password." },
  "too-short": { field: "newPassword", message: "The new password needs at least 12 characters." },
  "too-long": { field: "newPassword", message: "The new password can have at most 200 characters." },
};

/** Any signed-in role sets the name shown in place of their email (decision 0154). */
function NameForm({ user, onName }: { user: User; onName: (displayName: string | null) => void }) {
  const { t } = useLanguage();
  const [value, setValue] = useState(user.displayName ?? "");
  const [state, setState] = useState<"idle" | "saved" | string>("idle");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState("idle");
    const displayName = value.trim() || null;
    try {
      await api("PUT", "/auth/profile", { displayName });
      setValue(displayName ?? "");
      onName(displayName);
      setState("saved");
    } catch (err) {
      setState((err as Error).message);
    }
  };
  return (
    <form className="wk-body wk-fields" onSubmit={submit} noValidate aria-label={t("Your name")}>
      <div className="wk-pair wk-pair-action">
        <div>
          <label htmlFor="display-name">{t("Name")}</label>
          <input id="display-name" value={value} maxLength={60} autoComplete="name" placeholder={user.email} title={t("Shown instead of your email in the sidebar, the team list and approvals. Leave it empty to show your email.")} onChange={(e) => setValue(e.target.value)} />
        </div>
        <div>
          <label htmlFor="sign-in-email">{t("Sign-in email")}</label>
          <input id="sign-in-email" value={user.email} disabled readOnly />
        </div>
        <button className="wk-button blue">{t("Save name")}</button>
      </div>
      <p role="status" className="wk-note ok" hidden={state !== "saved"}>{state === "saved" && t("Name saved.")}</p>
      <p role="alert" className="wk-note bad" hidden={state === "idle" || state === "saved"}>{state !== "idle" && state !== "saved" ? state : ""}</p>
    </form>
  );
}

/** Change password for any signed-in role. The API signs out every other session. */
function PasswordForm() {
  const { t } = useLanguage();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<{ message: string; field: "currentPassword" | "newPassword" } | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    const form = e.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword"));
    const newPassword = String(data.get("newPassword"));
    const issue = checkPasswordChange(currentPassword, newPassword);
    if (issue) return setError({ field: ISSUES[issue].field, message: t(ISSUES[issue].message) });
    try {
      await api("POST", "/auth/password", { currentPassword, newPassword });
      form.reset();
      setDone(true);
    } catch (err) {
      const message = (err as Error).message;
      setError({ message, field: /current password/i.test(message) ? "currentPassword" : "newPassword" });
    }
  };
  return (
    <form className="wk-body wk-fields" onSubmit={submit} noValidate aria-labelledby="change-password">
      <h3 className="wk-form-title" id="change-password">{t("Change password")}</h3>
      <div className="wk-pair">
      <div>
        <label htmlFor="current-password">{t("Current password")}</label>
        <input id="current-password" name="currentPassword" type="password" autoComplete="current-password" aria-invalid={error?.field === "currentPassword"} aria-describedby={error?.field === "currentPassword" ? "password-error" : undefined} />
      </div>
      <div>
        <label htmlFor="new-password">{t("New password")} <span className="wk-muted">{t("(at least 12 characters)")}</span></label>
        <input id="new-password" name="newPassword" type="password" autoComplete="new-password" aria-invalid={error?.field === "newPassword"} aria-describedby={error?.field === "newPassword" ? "password-error" : undefined} />
      </div>
      </div>
      <p role="status" className="wk-note ok" hidden={!done}>
        {done && t("Password changed. Your other sessions are signed out.")}
      </p>
      <p role="alert" id="password-error" className="wk-note bad" hidden={!error}>
        {error?.message}
      </p>
      <button className="wk-button blue">{t("Change password")}</button>
    </form>
  );
}

/** Name and password in one card: on Settings for workspace roles, on #/account for approvers and requesters (decision 0164). */
export function AccountCards({ user, onName }: { user: User; onName: (displayName: string | null) => void }) {
  const { t } = useLanguage();
  return (
    <section className="wk-card" aria-labelledby="account-security">
      <h2 className="wk-card-head" id="account-security"><span className="wk-card-title-group"><span className="card-ico" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 1 1 8 0v4" /></svg></span><b>{t("Account & Security")}</b></span><span className="wk-role">{t(ROLE_LABEL[user.role])}</span></h2>
      <NameForm user={user} onName={onName} />
      <PasswordForm />
      <p className="wk-body wk-muted">{t("Changing your password signs out every other device. Forgot it? Sign out and use Forgot password on the sign-in page.")}</p>
    </section>
  );
}

/** #/account for approvers and requesters, who have no Settings page. */
export function AccountPage({ backToRequests, user, onName }: { backToRequests?: boolean; user: User; onName: (displayName: string | null) => void }) {
  const { t } = useLanguage();
  return (
    <main className="page wk wk-account">
      <header className="wk-head">
        <div>
          <Breadcrumb
            items={
              backToRequests
                ? [{ label: t("My requests"), href: "#/" }, { label: t("Account") }]
                : [{ label: t("Settings"), href: "#/settings" }, { label: t("Account") }]
            }
          />
          <div className="wk-title-row"><h1>{t("Account")}</h1></div>
        </div>
      </header>
      <div className="wk-narrow"><AccountCards user={user} onName={onName} /></div>
    </main>
  );
}
