import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import { useLanguage } from "./Language";

/** The secret as authenticator apps print it, in groups of four, so it can be typed by hand. */
export const groupInFours = (secret: string) => secret.match(/.{1,4}/g)?.join(" ") ?? "";

/** A centred card for the screens before the console: sign-in, two-factor setup and the code prompt (decision 0158). */
function Gate({ title, onSignOut, children }: { title: string; onSignOut?: () => void; children: ReactNode }) {
  const { t } = useLanguage();
  return (
    <main className="page wk ad-gate" id="admin-main">
      <section className="wk-card ad-gate-card motion-page" aria-labelledby="ad-gate-title">
        <div className="ad-brand">
          <img src="/logo.svg" alt="" width={20} height={20} />
          <span>kymavo</span>
          <span className="wk-chip">{t("Admin")}</span>
        </div>
        <h1 id="ad-gate-title">{title}</h1>
        {children}
        {onSignOut && <button type="button" className="wk-button ad-gate-out" onClick={onSignOut}>{t("Sign out")}</button>}
      </section>
    </main>
  );
}

/** Runs a form's request with a busy flag and the API's message as the error. */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = (work: (form: FormData) => Promise<void>) => async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await work(form);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return { busy, error, run };
}

const Problem = ({ id, text }: { id: string; text: string }) => <p id={id} role="alert" className="wk-note bad" hidden={!text}>{text}</p>;

function CodeField({ id, label, error }: { id: string; label: string; error: string }) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <input id={id} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
    </div>
  );
}

/** The admin host's own sign-in: the session cookie there is for that host only (decision 0157). */
export function AdminSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useLanguage();
  const { busy, error, run } = useSubmit();
  const submit = run(async (form) => {
    await api("POST", "/auth/login", { email: form.get("email"), password: form.get("password") });
    onSignedIn();
  });
  return (
    <Gate title={t("Sign in to the admin console")}>
      <form className="wk-fields" onSubmit={(e) => void submit(e)}>
        <div>
          <label htmlFor="ad-email">{t("Email")}</label>
          <input id="ad-email" name="email" type="email" autoComplete="username" required />
        </div>
        <div>
          <label htmlFor="ad-password">{t("Password")}</label>
          <input id="ad-password" name="password" type="password" autoComplete="current-password" required aria-describedby={error ? "ad-signin-error" : undefined} />
        </div>
        <Problem id="ad-signin-error" text={error} />
        <button className="wk-button blue" disabled={busy}>{t("Sign in")}</button>
      </form>
    </Gate>
  );
}

/** First sign-in of an admin: a new secret, confirmed by one code, then the recovery codes once. */
export function EnrollTwoFactor({ onDone, onSignOut }: { onDone: () => void; onSignOut: () => void }) {
  const { t } = useLanguage();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const start = useSubmit();
  const confirm = useSubmit();
  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />;
  const begin = start.run(async () => setSetup(await api<{ secret: string; uri: string }>("POST", "/admin/2fa/enroll")));
  const turnOn = confirm.run(async (form) => {
    setCodes((await api<{ recoveryCodes: string[] }>("POST", "/admin/2fa/enroll/confirm", { code: String(form.get("code")) })).recoveryCodes);
  });
  return (
    <Gate title={t("Set up two-factor sign-in")} onSignOut={onSignOut}>
      <p className="wk-sub">{t("The admin console needs a code from an authenticator app on your phone each time you sign in, and every 12 hours.")}</p>
      {setup === null ? (
        <form className="wk-fields" onSubmit={(e) => void begin(e)}>
          <Problem id="ad-start-error" text={start.error} />
          <button className="wk-button blue" disabled={start.busy}>{t("Start setup")}</button>
        </form>
      ) : (
        <form className="wk-fields" onSubmit={(e) => void turnOn(e)}>
          <ol className="ad-steps">
            <li>
              {t("In your authenticator app, add an account and enter this key:")}
              <code className="ad-secret" aria-label={t("Setup key")}>{groupInFours(setup.secret)}</code>
            </li>
            <li>
              <label htmlFor="ad-uri">{t("Or paste this setup link into an app that takes one:")}</label>
              <input id="ad-uri" readOnly value={setup.uri} onFocus={(e) => e.currentTarget.select()} />
            </li>
            <li>{t("Enter the 6-digit code the app shows.")}</li>
          </ol>
          <CodeField id="ad-enroll-code" label={t("Code from your app")} error={confirm.error} />
          <Problem id="ad-enroll-code-error" text={confirm.error} />
          <button className="wk-button blue" disabled={confirm.busy}>{t("Turn on two-factor sign-in")}</button>
        </form>
      )}
    </Gate>
  );
}

/** Shown once, right after enrollment. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState("");
  const copy = () => navigator.clipboard.writeText(codes.join("\n")).then(() => setCopied(t("Copied.")), () => setCopied(t("Copy did not work. Select the codes and copy them by hand.")));
  return (
    <Gate title={t("Save your recovery codes")}>
      <p className="wk-sub">{t("If you lose your phone, each of these codes signs you in once. They are shown only now: keep them in your password manager.")}</p>
      <ol className="ad-codes" aria-label={t("Recovery codes")}>
        {codes.map((c) => <li key={c}><code>{c}</code></li>)}
      </ol>
      <div className="ad-gate-actions">
        <button type="button" className="wk-button" onClick={() => void copy()}>{t("Copy the codes")}</button>
        <span role="status" className="wk-sub">{copied}</span>
      </div>
      <button type="button" className="wk-button blue" onClick={onDone}>{t("I saved them")}</button>
    </Gate>
  );
}

/** The code prompt after sign-in, with a way to use a recovery code instead. */
export function VerifyTwoFactor({ onDone, onSignOut }: { onDone: () => void; onSignOut: () => void }) {
  const { t } = useLanguage();
  const [recovery, setRecovery] = useState(false);
  const { busy, error, run } = useSubmit();
  const submit = run(async (form) => {
    await api("POST", "/admin/2fa/verify", recovery ? { recoveryCode: String(form.get("recoveryCode")) } : { code: String(form.get("code")) });
    onDone();
  });
  return (
    <Gate title={t("Enter your two-factor code")} onSignOut={onSignOut}>
      <form className="wk-fields" onSubmit={(e) => void submit(e)}>
        {recovery ? (
          <div>
            <label htmlFor="ad-recovery">{t("Recovery code")}</label>
            <input id="ad-recovery" name="recoveryCode" autoComplete="off" required aria-invalid={!!error} aria-describedby={error ? "ad-verify-error" : undefined} />
          </div>
        ) : (
          <CodeField id="ad-verify-code" label={t("Code from your app")} error={error} />
        )}
        <Problem id={recovery ? "ad-verify-error" : "ad-verify-code-error"} text={error} />
        <button className="wk-button blue" disabled={busy}>{t("Verify")}</button>
        <button type="button" className="wk-button" onClick={() => setRecovery(!recovery)}>{recovery ? t("Use a code from the app") : t("Use a recovery code")}</button>
      </form>
    </Gate>
  );
}

/** The console's note that two-factor is on, and its reset, which takes a fresh code. */
export function TwoFactorStatus({ onReset }: { onReset: () => void }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useSubmit();
  const reset = run(async (form) => {
    await api("POST", "/admin/2fa/reset", { code: String(form.get("code")) });
    onReset();
  });
  return (
    <div className="ad-2fa">
      <span className="wk-chip">{t("2FA on")}</span>
      {open ? (
        <form className="wk-fields" onSubmit={(e) => void reset(e)}>
          <CodeField id="ad-reset-code" label={t("A new code from your app")} error={error} />
          <Problem id="ad-reset-code-error" text={error} />
          <div className="ad-gate-actions">
            <button className="wk-button danger-quiet" disabled={busy}>{t("Reset 2FA")}</button>
            <button type="button" className="wk-button" onClick={() => setOpen(false)}>{t("Cancel")}</button>
          </div>
        </form>
      ) : (
        <button type="button" className="wk-button" onClick={() => setOpen(true)}>{t("Reset 2FA")}</button>
      )}
    </div>
  );
}
