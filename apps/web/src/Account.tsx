import "./workspace-admin.css";
import "./workspace.css";
import { Breadcrumb } from "./Breadcrumb";
import { useState, type FormEvent } from "react";
import { api } from "./api";
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

/** Change password for any signed-in role. The API signs out every other session. */
export function AccountPage({ backToRequests }: { backToRequests?: boolean }) {
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
      <section className="wk-card wk-narrow" aria-labelledby="change-password">
        <h2 className="wk-card-head" id="change-password"><b>{t("Change password")}</b></h2>
        <form className="wk-body wk-fields" onSubmit={submit} noValidate>
          <div>
            <label htmlFor="current-password">{t("Current password")}</label>
            <input id="current-password" name="currentPassword" type="password" autoComplete="current-password" aria-invalid={error?.field === "currentPassword"} aria-describedby={error?.field === "currentPassword" ? "password-error" : undefined} />
          </div>
          <div>
            <label htmlFor="new-password">{t("New password")} <span className="wk-muted">{t("(at least 12 characters)")}</span></label>
            <input id="new-password" name="newPassword" type="password" autoComplete="new-password" aria-invalid={error?.field === "newPassword"} aria-describedby={error?.field === "newPassword" ? "password-error" : undefined} />
          </div>
          <p role="status" className="wk-note ok" hidden={!done}>
            {done && t("Password changed. Your other sessions are signed out.")}
          </p>
          <p role="alert" id="password-error" className="wk-note bad" hidden={!error}>
            {error?.message}
          </p>
          <button className="wk-button blue">{t("Change password")}</button>
        </form>
      </section>
    </main>
  );
}
