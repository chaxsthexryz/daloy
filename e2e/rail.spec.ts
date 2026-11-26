import { expect, test, type Page } from "@playwright/test";

// U1: the rail opens on hover intent (250 ms in, 200 ms out), the AI meter shows in the rail and on Settings, and
// textareas use Inter while the raw payload box stays monospace.
async function signUp(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`rail-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
}

test("the desktop sidebar stays permanently at 228 px without collapsing, and Quick jump navigates with Cmd/Ctrl+K", async ({ page }) => {
  await signUp(page);
  const rail = page.locator("aside.sidebar");
  await expect(rail).toHaveCSS("width", "228px");
  await expect(rail).not.toHaveAttribute("data-expanded", /.*/);
  await expect(rail.getByRole("button", { name: "Collapse sidebar" })).toHaveCount(0);
  await rail.hover();
  await expect(rail).toHaveCSS("width", "228px");
  await expect(rail).not.toHaveAttribute("data-expanded", /.*/);
  const library = page.getByRole("link", { name: "Library", exact: true });
  await expect(library).toHaveAttribute("href", "#/new");
  await expect(rail.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("link", { name: "New automation", exact: true }).first()).toHaveAttribute("href", "#/new");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Quick jump" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("searchbox").fill("book");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/bookings$/);
  await expect(dialog).toBeHidden();
});

test("reduced motion disables transitions on the sidebar hover pill", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signUp(page);
  const rail = page.locator("aside.sidebar");
  await expect(rail).toHaveCSS("width", "228px");
  await expect(rail.locator(".rail-hover-pill")).toHaveCSS("transition-duration", "0s");
  await expect(rail.getByRole("link", { name: "Library", exact: true })).toBeVisible();
});

const withUsage = (page: Page, limit: number | null) => page.route("**/usage", (route) => route.fulfill({ json: {
  plan: "pilot", label: "Pilot", limits: {},
  ai: { used: 120, limit, resetsOn: "2026-12-17" },
  email: { used: 0, limit: 100, resetsOn: "2026-11-18" }, http: { used: 0, limit: null, resetsOn: "2026-11-18" },
  automations: { live: 1, limit: 5 }, minScheduleMinutes: 15,
} }));

test("the AI meter shows in the rail and on Settings, and refreshes on daloy:usage", async ({ page }) => {
  await withUsage(page, 500);
  await signUp(page);
  const name = "AI 120 of 500 this month";
  const rail = page.locator("aside.sidebar");
  await expect(rail.getByRole("progressbar", { name })).toBeVisible();
  await expect(rail.getByRole("progressbar", { name })).toHaveAttribute("aria-valuenow", "120");
  await page.goto("/#/settings");
  await expect(page.locator("main").getByRole("progressbar", { name })).toBeVisible();
  // The event reloads usage; page changes alone do not.
  let calls = 0;
  await page.route("**/usage", (route) => { calls += 1; return route.fallback(); });
  await page.goto("/#/activity");
  await page.waitForTimeout(300);
  expect(calls).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event("daloy:usage")));
  await expect.poll(() => calls).toBeGreaterThan(0);
});

test("the AI meter stays hidden when the plan has no AI limit", async ({ page }) => {
  await withUsage(page, null);
  await signUp(page);
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Plan and usage" })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});

test("textareas use Geist with tabular figures", async ({ page }) => {
  await signUp(page);
  await page.goto("/#/ai");
  const textarea = page.locator("textarea").first();
  await expect(textarea).toBeVisible();
  expect(await textarea.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Geist|Inter/);
  expect(await textarea.evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toContain("tabular-nums");
});

test("the ? Help and support menu in the sidebar footer opens setup and usage shortcuts and closes on Escape", async ({ page }) => {
  await signUp(page);
  const rail = page.locator("aside.sidebar");
  const helpBtn = rail.getByRole("button", { name: "Help and support" });
  await helpBtn.click();
  const menu = page.getByRole("menu", { name: "Help and support" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Business setup guide" })).toHaveAttribute("href", "#/onboarding");
  await expect(menu.getByRole("menuitem", { name: "Plan and usage" })).toHaveAttribute("href", "#/settings");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(helpBtn).toBeFocused();
});
