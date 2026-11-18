import "./workspace-admin.css";
import { useState, type FormEvent } from "react";
import { api } from "./api";
import { useLanguage } from "./Language";

const Brand = () => (
  <h1 className="brand">
    <img src="/logo.svg" alt="" width="32" height="32" />
    Daloy
  </h1>
);

/** Pre-login, so plain English like the sign-in page. Always the same answer, whether or not the account exists. */
export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    try {
      await api("POST", "/auth/password-reset", { email: new FormData(e.currentTarget).get("email") });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <main className="page narrow">
      <Brand />
      <form onSubmit={submit}>
        <h2>Forgot your password?</h2>
        {sent ? (
          <p role="status" className="message ok">If an account exists for that email, we sent a link to set a new password. It works once, for 30 minutes.</p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="forgot-email">Email</label>
              <input id="forgot-email" name="email" type="email" autoComplete="email" required />
            </div>
            <p role="alert" className="message error" hidden={!error}>
              {error}
            </p>
            <div className="actions">
              <button className="primary">Send link</button>
            </div>
          </>
        )}
        <p><a href="#/">Back to sign in</a></p>
      </form>
    </main>
  );
}

/** The page behind the link in the reset email. */
export function ResetPasswordPage({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    try {
      await api("POST", `/auth/password-reset/${token}`, { password: new FormData(e.currentTarget).get("password") });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <main className="page narrow">
      <Brand />
      <form onSubmit={submit}>
        <h2>Set a new password</h2>
        {done ? (
          <>
            <p role="status" className="message ok">Password changed. Sign in with your new password.</p>
            <p><a href="#/">Sign in</a></p>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="reset-password">New password <span className="muted">(at least 12 characters)</span></label>
              <input id="reset-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={200} required />
            </div>
            <p role="alert" className="message error" hidden={!error}>
              {error}
            </p>
            <div className="actions">
              <button className="primary">Change password</button>
            </div>
            <p><a href="#/forgot-password">Send a new link</a></p>
          </>
        )}
      </form>
    </main>
  );
}

/** Change password for any signed-in role. The API signs out every other session. */
export function AccountPage({ backToRequests }: { backToRequests?: boolean }) {
  const { t } = useLanguage();
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setDone(false);
    const form = e.currentTarget;
    const data = new FormData(form);
    try {
      await api("POST", "/auth/password", { currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword") });
      form.reset();
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <main className="page narrow workspace-admin admin-account">
      <header className="toolbar plain">
        {backToRequests && <a href="#/">{t("My requests")}</a>}
        <h1>{t("Account")}</h1>
      </header>
      <form onSubmit={submit}>
        <h2>{t("Change password")}</h2>
        <div className="field">
          <label htmlFor="current-password">{t("Current password")}</label>
          <input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required />
        </div>
        <div className="field">
          <label htmlFor="new-password">{t("New password")} <span className="muted">{t("(at least 12 characters)")}</span></label>
          <input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={200} required />
        </div>
        <p role="status" className="message ok" hidden={!done}>
          {done && t("Password changed. Your other sessions are signed out.")}
        </p>
        <p role="alert" className="message error" hidden={!error}>
          {error}
        </p>
        <div className="actions">
          <button className="primary">{t("Change password")}</button>
        </div>
      </form>
    </main>
  );
}
