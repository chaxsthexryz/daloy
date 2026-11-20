import { useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import { AuthLayout, AuthNote } from "./AuthLayout";
import { checkNewPassword } from "./lib/password";
import type { User } from "./Team";

type Problem = { field: "email" | "password"; message: string };

/**
 * The signed-out console (Doop rows E1 and E2): sign in, or create an account with a first workspace.
 * `approval` is set when the person arrived through #/answer/<token>; App.tsx then sends them on to the approval page.
 */
export function SignIn({ onDone, approval }: { onDone: (u: User) => void; approval?: boolean }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const register = mode === "register";
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    // The API refuses a short password too; checking first puts the reason beside the field without a request.
    if (register && checkNewPassword(password) === "too-short") return setProblem({ field: "password", message: "Password must be at least 12 characters." });
    setProblem(null);
    setBusy(true);
    try {
      onDone(await api<User>("POST", `/auth/${mode}`, { email, password }));
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setBusy(false);
      if (!register && status === 401) setProblem({ field: "password", message: "Wrong email or password." });
      else setProblem({ field: register && status === 409 ? "email" : "password", message: (err as Error).message });
    }
  };
  const flip = () => (setMode(register ? "login" : "register"), setProblem(null));
  const forgot = <a className="au-link" href="#/forgot-password">Forgot your password?</a>;
  const notice = approval && (
    <AuthNote kind="info">An approval is waiting for you. Sign in with the email it was sent to, and Daloy takes you straight to it.</AuthNote>
  );
  return (
    <AuthLayout title={register ? "Create an account" : "Sign in"} points notice={notice}>
      <form onSubmit={submit} className="au-fields">
        <div className="au-field">
          <div className="au-label-row"><label htmlFor="email">Email</label></div>
          <input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required aria-invalid={problem?.field === "email"} aria-describedby={problem ? "sign-in-error" : undefined} />
        </div>
        <div className="au-field">
          <div className="au-label-row">
            <label htmlFor="password">Password {register && <span>(at least 12 characters)</span>}</label>
            {!register && <span className="au-forgot-inline">{forgot}</span>}
          </div>
          <input id="password" name="password" type="password" autoComplete={register ? "new-password" : "current-password"} placeholder="Password" required aria-invalid={problem?.field === "password"} aria-describedby={problem ? "sign-in-error" : undefined} />
          {problem && <AuthNote kind="error" id="sign-in-error">{problem.message}</AuthNote>}
        </div>
        <button className="au-button" disabled={busy}>{register ? "Create account" : "Sign in"}</button>
      </form>
      {!register && <p className="au-forgot-below">{forgot}</p>}
      <p className="au-aside">
        {register ? "Already use Daloy?" : "New to Daloy?"}
        <button type="button" className="au-link" onClick={flip}>{register ? "I have an account" : "Create an account"}</button>
      </p>
    </AuthLayout>
  );
}
