import { AppsPage } from "./Apps";
import { BusinessSetupPage } from "./BusinessSetup";
import { KnowledgePage } from "./Knowledge";
import { useLanguage } from "./Language";
import { PageHead } from "./Runs";
import { TeamPage, type User } from "./Team";

export type BusinessTab = "details" | "knowledge" | "apps" | "team";

// The sidebar tree links each page (decision 0164), so the page carries its own title and no tab bar.
const TITLES: Record<BusinessTab, { title: string; sub: string }> = {
  details: { title: "Details and branding", sub: "Business identity, public form accent, and customer preview." },
  knowledge: { title: "Knowledge", sub: "Write what guests ask about: rooms, rates, policies, questions and links. The concierge answers only from the published version, so check prices before you publish." },
  apps: { title: "Apps", sub: "Everything here is optional. Each app is used only by the automations you turn on, and the demo works without any of them." },
  team: { title: "Team", sub: "Workspace members, roles, and pending invitations." },
};

/** #/business: workspace details, Knowledge, Apps and Team in one place. */
export function BusinessPage({
  user,
  initialTab = "details",
  initialApp,
  outcome,
}: {
  user: User;
  initialTab?: BusinessTab;
  initialApp?: string;
  outcome?: { app: string; code: string };
}) {
  const { t } = useLanguage();
  const owner = user.role === "owner";
  const tab: BusinessTab = owner ? initialTab : "knowledge";

  return (
    <main className="page act">
      <PageHead crumbs={[]} title={t(TITLES[tab].title)} sub={t(TITLES[tab].sub)} />
      {tab === "details" && <BusinessSetupPage embedded />}
      {tab === "knowledge" && <KnowledgePage embedded />}
      {tab === "apps" && <AppsPage embedded outcome={outcome} initialApp={initialApp} />}
      {tab === "team" && <TeamPage user={user} embedded />}
    </main>
  );
}
