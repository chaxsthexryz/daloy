/** The admin console's tabs, in navigation order (decision 0152). */
export const ADMIN_TABS = ["overview", "workspaces", "runs", "ai", "feedback", "audit"] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

/** Reads `#/<tab>?<query>`. An empty, unknown or hidden tab opens the overview. */
export function adminRoute(hash: string, tabs: readonly AdminTab[] = ADMIN_TABS): { tab: AdminTab; params: URLSearchParams } {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const name = path.replace(/\/+$/, "");
  const tab = tabs.find((t) => t === name) ?? "overview";
  return { tab, params: new URLSearchParams(query) };
}

export const tabHref = (tab: AdminTab, query?: Record<string, string>) => `#/${tab}${query ? `?${new URLSearchParams(query)}` : ""}`;
