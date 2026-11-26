import "./request-access.css";
import { useEffect, useState } from "react";
import { api } from "./api";
import { LanguageContext } from "./Language";
import type { Language } from "./lib/locale";
import { Editor } from "./Editor";
import { RunPage, RunsPage } from "./Runs";
import { AskPage, AskRunPage } from "./AskRequest";
import { AdvancedPage } from "./Advanced";
import { AdminPage } from "./Admin";
import { Automations } from "./Automations";
import { NewAutomationPage } from "./NewAutomation";
import { BuildWithAiPage } from "./BuildWithAi";
import { OfficeRequestPage, TryOfficeRequest } from "./OfficeRequests";
import { BookingsPage } from "./Bookings";
import { ConversationsPage } from "./Conversations";
import { ReceiptsPage } from "./Receipts";
import { KnowledgePage } from "./Knowledge";
import { ResourcesPage } from "./Resources";
import { AiModelPage } from "./Settings";
import { SettingsPage } from "./AppSettings";
import { BusinessSetupPage, VerifySenderPage } from "./BusinessSetup";
import { OnboardingPage } from "./Onboarding";
import { AppsPage } from "./Apps";
import { SecretsPage } from "./Secrets";
import { TokensPage } from "./Tokens";
import { VersionsPage } from "./Versions";
import { Shell } from "./Nav";
import { useLanguage } from "./Language";
import { AccountPage, ForgotPasswordPage, ResetPasswordPage } from "./Account";
import { SignIn } from "./SignIn";
import { AcceptInvitePage, MyRequestsPage, TeamPage, type User } from "./Team";

const ANSWER = /^#\/answer\/([A-Za-z0-9_-]{43})$/;
const RESET = /^#\/reset-password\/([A-Za-z0-9_-]{43})$/;
const INVITE = /^#\/invite\/([A-Za-z0-9_-]{43})$/;

/**
 * Hash routes (#/ is Automations, #/advanced the developer menu, #/w/<id>, #/w/<id>/runs, #/w/<id>/versions, #/runs/<id> (and #/runs/<id>/ask), #/tokens, #/secrets, #/settings, #/settings/ai, #/settings/business, #/onboarding (first-time setup), #/apps (and #/apps/<app>-<outcome>), #/activity (and #/activity/ask), #/new, #/ai (Build with AI), #/resources, #/bookings, #/receipts, #/knowledge,
 * #/verify-sender/<token> for the Gmail confirmation link, #/team, #/invite/<token> for an invite link,
 * #/admin for platform admins (decision 0120),
 * #/forgot-password and #/reset-password/<token> before sign-in, #/account to change the password,
 * #/answer/<token> to sign in before a named approval (decision 0022),
 * #/try/office-request for the preview and #/a/<id> for a guided automation),
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
  const hash = useHash();
  return <Console hash={hash} />;
}

function Console({ hash }: { hash: string }) {
  const [language, setLanguage] = useState<Language>("en");
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    api<User>("GET", "/auth/me").then(setUser, () => setUser(null));
  }, []);
  useEffect(() => {
    setLanguage(user?.language === "tl" ? "tl" : "en");
  }, [user?.language]);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  // Back to the server-rendered approval page once signed in; it checks again that this user is the approver.
  const answer = ANSWER.exec(hash)?.[1];
  useEffect(() => {
    if (user && answer) location.replace(`/approvals/${answer}`);
  }, [user, answer]);
  const signOut = () => api("POST", "/auth/logout").then(() => { location.hash = "#/"; setUser(null); });

  if (user === undefined || (user && answer)) return <main className="page" />;
  const invite = INVITE.exec(hash);
  if (invite) return <AcceptInvitePage key={invite[1]} token={invite[1]!} onDone={setUser} />;
  const reset = RESET.exec(hash);
  if (reset) return <ResetPasswordPage key={reset[1]} token={reset[1]!} />;
  if (!user) return hash === "#/forgot-password" ? (
    <ForgotPasswordPage />
  ) : (
    <SignIn
      initialMode={hash === "#/signup" ? "register" : "login"}
      approval={!!answer}
      onDone={(u, ctx) => {
        if (ctx?.registered && hash === "#/signup" && u.role === "owner") location.hash = "#/onboarding";
        setUser(u);
      }}
    />
  );
  // Approvers and requesters have no console beyond their own requests; the API refuses the rest anyway.
  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {user.role === "approver" || user.role === "requester" ? (hash === "#/account" ? <AccountPage backToRequests /> : <MyRequestsPage user={user} onSignOut={signOut} />) : (
        <Shell user={user} hash={hash} onSignOut={signOut}>
          <Route hash={hash} user={user} />
        </Shell>
      )}
    </LanguageContext.Provider>
  );
}

function Route({ hash, user }: { hash: string; user: User }) {
  const canAsk = user.ask === true && (user.role === "owner" || user.role === "operator");
  // #/w/<id>?from=<runId> opens the editor with that run's trigger data as the sample (T2). Only ids go in the URL.
  const page = /^#\/w\/([0-9a-f-]{36})(?:\/(runs|versions)|\?from=([0-9a-f-]{36}))?$/.exec(hash);
  if (page?.[2] === "runs") return <RunsPage key={page[1]} workflowId={page[1]!} ask={canAsk} />;
  if (page?.[2] === "versions") return <VersionsPage key={page[1]} workflowId={page[1]!} />;
  if (page) return <Editor key={page[1]} id={page[1]!} from={page[3]} />;
  const run = /^#\/runs\/([0-9a-f-]{36})(\/ask)?$/.exec(hash);
  if (run?.[2] && canAsk) return <AskRunPage key={run[1]} runId={run[1]!} />;
  if (run) return <RunPage key={run[1]} runId={run[1]!} owner={user.role === "owner"} ask={canAsk} admin={user.admin === true} />;
  const guided = /^#\/a\/([0-9a-f-]{36})$/.exec(hash);
  if (guided) return <OfficeRequestPage key={guided[1]} id={guided[1]!} />;
  if (hash === "#/activity" && (user.role === "owner" || user.role === "operator")) return <RunsPage ask={canAsk} />;
  if (hash === "#/activity/ask" && canAsk) return <AskPage />;
  // Platform admin (A1): any signed-in role may open it; the API decides who sees anything (PLATFORM_ADMINS).
  if (hash === "#/admin") return <AdminPage />;
  if (hash === "#/try/office-request") return <TryOfficeRequest email={user.email} />;
  if (hash === "#/advanced" && user.role === "owner" && user.admin === true) return <AdvancedPage />;
  if (hash === "#/new" && user.role === "owner") return <NewAutomationPage email={user.email} />;
  if (hash === "#/ai" && user.role === "owner") return <BuildWithAiPage email={user.email} admin={user.admin === true} />;
  if (hash === "#/secrets" && user.role === "owner") return <SecretsPage admin={user.admin === true} />;
  if (hash === "#/tokens" && user.admin === true) return <TokensPage />;
  if (hash === "#/settings") return <SettingsPage user={user} />;
  if (hash === "#/account") return <AccountPage />;
  if (hash === "#/settings/ai") return user.admin === true ? <AiModelPage /> : <NotFoundPage aiRestricted />;
  if (hash === "#/apps") return <AppsPage />;
  // #/apps/<slug>-<outcome> is where the OAuth consent callback lands (decision 0058). Outlook's callback from decision
  // 0023 still lands on #/settings/business/outlook-<outcome>.
  const back = /^#\/apps\/([a-z-]+)-([a-z_]+)$/.exec(hash) ?? /^#\/settings\/business\/(outlook)-([a-z_]+)$/.exec(hash);
  if (back) return <AppsPage outcome={{ app: back[1]!, code: back[2]! }} />;
  if (hash === "#/settings/business") return <BusinessSetupPage />;
  if (hash === "#/onboarding" && user.role === "owner") return <OnboardingPage />;
  if (hash === "#/team" && user.role === "owner") return <TeamPage user={user} />;
  if (hash === "#/resources" && user.role === "owner") return <ResourcesPage />;
  if (hash === "#/bookings" && (user.role === "owner" || user.role === "operator")) return <BookingsPage />;
  if (hash === "#/conversations" && (user.role === "owner" || user.role === "operator")) return <ConversationsPage user={user} />;
  if (hash === "#/knowledge" && (user.role === "owner" || user.role === "operator")) return <KnowledgePage />;
  if (hash === "#/receipts" && (user.role === "owner" || user.role === "operator")) return <ReceiptsPage user={user} />;
  const verify = /^#\/verify-sender\/([A-Za-z0-9_-]{43})$/.exec(hash);
  if (verify) return <VerifySenderPage key={verify[1]} token={verify[1]!} />;
  if (hash === "" || hash === "#" || hash === "#/" || /^#\/(signup|advanced|new|ai|secrets|tokens|onboarding|team|resources|bookings|conversations|knowledge|receipts|activity|activity\/ask)$/.test(hash)) {
    return <Automations user={user} />;
  }
  return <NotFoundPage />;
}

function NotFoundPage({ aiRestricted = false }: { aiRestricted?: boolean }) {
  const { t } = useLanguage();
  return (
    <main className="page">
      <h1>{t("Page not found")}</h1>
      <p className="muted">
        {t(aiRestricted ? "AI model settings are managed by the kymavo operator for this workspace." : "This page does not exist, or your account cannot open it.")}
      </p>
      <p className="actions">
        <a className="button" href="#/">{t("Back to Automations")}</a>
        {aiRestricted && <a className="button" href="#/settings">{t("Settings")}</a>}
      </p>
    </main>
  );
}
