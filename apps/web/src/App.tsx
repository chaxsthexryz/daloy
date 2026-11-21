import "./request-access.css";
import { useEffect, useState } from "react";
import { api } from "./api";
import { LanguageContext } from "./Language";
import type { Language } from "./lib/locale";
import { Editor } from "./Editor";
import { RunPage, RunsPage } from "./Runs";
import { AskPage, AskRunPage } from "./AskRequest";
import { AdvancedPage } from "./Advanced";
import { Automations } from "./Automations";
import { NewAutomationPage } from "./NewAutomation";
import { BuildWithAiPage } from "./BuildWithAi";
import { OfficeRequestPage, TryOfficeRequest } from "./OfficeRequests";
import { BookingsPage } from "./Bookings";
import { ReceiptsPage } from "./Receipts";
import { ResourcesPage } from "./Resources";
import { AiModelPage } from "./Settings";
import { SettingsPage } from "./AppSettings";
import { BusinessSetupPage, VerifySenderPage } from "./BusinessSetup";
import { AppsPage } from "./Apps";
import { SecretsPage } from "./Secrets";
import { TokensPage } from "./Tokens";
import { VersionsPage } from "./Versions";
import { Shell } from "./Nav";
import { AccountPage, ForgotPasswordPage, ResetPasswordPage } from "./Account";
import { SignIn } from "./SignIn";
import { AcceptInvitePage, MyRequestsPage, TeamPage, type User } from "./Team";

const ANSWER = /^#\/answer\/([A-Za-z0-9_-]{43})$/;
const RESET = /^#\/reset-password\/([A-Za-z0-9_-]{43})$/;
const INVITE = /^#\/invite\/([A-Za-z0-9_-]{43})$/;

/**
 * Hash routes (#/ is Automations, #/advanced the developer menu, #/w/<id>, #/w/<id>/runs, #/w/<id>/versions, #/runs/<id> (and #/runs/<id>/ask), #/tokens, #/secrets, #/settings, #/settings/ai, #/settings/business, #/apps (and #/apps/<app>-<outcome>), #/activity (and #/activity/ask), #/new, #/ai (Build with AI), #/resources, #/bookings, #/receipts,
 * #/verify-sender/<token> for the Gmail confirmation link, #/team, #/invite/<token> for an invite link,
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
  const signOut = () => api("POST", "/auth/logout").then(() => setUser(null));

  if (user === undefined || (user && answer)) return <main className="page" />;
  const invite = INVITE.exec(hash);
  if (invite) return <AcceptInvitePage key={invite[1]} token={invite[1]!} onDone={setUser} />;
  const reset = RESET.exec(hash);
  if (reset) return <ResetPasswordPage key={reset[1]} token={reset[1]!} />;
  if (!user) return hash === "#/forgot-password" ? <ForgotPasswordPage /> : <SignIn onDone={setUser} approval={!!answer} />;
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
  const page = /^#\/w\/([0-9a-f-]{36})(?:\/(runs|versions))?$/.exec(hash);
  if (page?.[2] === "runs") return <RunsPage key={page[1]} workflowId={page[1]!} ask={canAsk} />;
  if (page?.[2] === "versions") return <VersionsPage key={page[1]} workflowId={page[1]!} />;
  if (page) return <Editor key={page[1]} id={page[1]!} />;
  const run = /^#\/runs\/([0-9a-f-]{36})(\/ask)?$/.exec(hash);
  if (run?.[2] && canAsk) return <AskRunPage key={run[1]} runId={run[1]!} />;
  if (run) return <RunPage key={run[1]} runId={run[1]!} owner={user.role === "owner"} ask={canAsk} />;
  const guided = /^#\/a\/([0-9a-f-]{36})$/.exec(hash);
  if (guided) return <OfficeRequestPage key={guided[1]} id={guided[1]!} />;
  if (hash === "#/activity" && (user.role === "owner" || user.role === "operator")) return <RunsPage ask={canAsk} />;
  if (hash === "#/activity/ask" && canAsk) return <AskPage />;
  if (hash === "#/try/office-request") return <TryOfficeRequest email={user.email} />;
  if (hash === "#/advanced" && user.role === "owner") return <AdvancedPage />;
  if (hash === "#/new" && user.role === "owner") return <NewAutomationPage email={user.email} />;
  if (hash === "#/ai" && user.role === "owner") return <BuildWithAiPage email={user.email} />;
  if (hash === "#/secrets" && user.role === "owner") return <SecretsPage />;
  if (hash === "#/tokens") return <TokensPage />;
  if (hash === "#/settings") return <SettingsPage user={user} />;
  if (hash === "#/account") return <AccountPage />;
  if (hash === "#/settings/ai") return <AiModelPage />;
  if (hash === "#/apps") return <AppsPage />;
  // #/apps/<slug>-<outcome> is where the OAuth consent callback lands (decision 0058). Outlook's callback from decision
  // 0023 still lands on #/settings/business/outlook-<outcome>.
  const back = /^#\/apps\/([a-z-]+)-([a-z_]+)$/.exec(hash) ?? /^#\/settings\/business\/(outlook)-([a-z_]+)$/.exec(hash);
  if (back) return <AppsPage outcome={{ app: back[1]!, code: back[2]! }} />;
  if (hash === "#/settings/business") return <BusinessSetupPage />;
  if (hash === "#/team" && user.role === "owner") return <TeamPage user={user} />;
  if (hash === "#/resources" && user.role === "owner") return <ResourcesPage />;
  if (hash === "#/bookings" && (user.role === "owner" || user.role === "operator")) return <BookingsPage />;
  if (hash === "#/receipts" && (user.role === "owner" || user.role === "operator")) return <ReceiptsPage user={user} />;
  const verify = /^#\/verify-sender\/([A-Za-z0-9_-]{43})$/.exec(hash);
  if (verify) return <VerifySenderPage key={verify[1]} token={verify[1]!} />;
  return <Automations user={user} />;
}
