import { AppsPage } from "./Apps";
import { BusinessSetupPage } from "./BusinessSetup";
import { KnowledgePage } from "./Knowledge";
import { useLanguage } from "./Language";
import { PageHead } from "./Runs";
import { TeamPage, type User } from "./Team";

export type BusinessTab = "details" | "knowledge" | "apps" | "team";

const TABS: { key: BusinessTab; label: string; href: string }[] = [
  { key: "details", label: "Details and branding", href: "#/business" },
  { key: "knowledge", label: "Knowledge", href: "#/business?tab=knowledge" },
  { key: "apps", label: "Apps", href: "#/business?tab=apps" },
  { key: "team", label: "Team", href: "#/business?tab=team" },
];

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
      <PageHead
        crumbs={[]}
        title={t("Business")}
        sub={t("Business details, knowledge sheet, connected apps and team.")}
        tabs={
          owner ? (
            <nav className="tabs" aria-label={t("Business")}>
              {TABS.map((item) => (
                <a key={item.key} href={item.href} aria-current={tab === item.key ? "page" : undefined}>
                  {t(item.label)}
                </a>
              ))}
            </nav>
          ) : undefined
        }
      />
      {tab === "details" && <BusinessSetupPage embedded />}
      {tab === "knowledge" && <KnowledgePage embedded />}
      {tab === "apps" && <AppsPage embedded outcome={outcome} initialApp={initialApp} />}
      {tab === "team" && <TeamPage user={user} embedded />}
    </main>
  );
}
