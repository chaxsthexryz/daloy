import { expect, test, type Page } from "@playwright/test";

async function registerOwner(page: Page, prefix = "ux-g1-g5") {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  return email;
}

test("desktop full journey across G1-G5: 6-item nav, readiness, wizard, tabs, Settings, Inbox, Home", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await registerOwner(page, "g1g5-desk");

  // 1. Sidebar has exactly 6 primary destinations (G3)
  const navLinks = page.locator("#main-menu > a");
  await expect(navLinks).toHaveCount(6);
  for (const label of ["Home", "Inbox", "Bookings", "Automations", "Business", "Settings"]) {
    await expect(navLinks.getByText(label, { exact: true })).toBeVisible();
  }

  // 2. Today Home shows Needs you, Problems, What ran (G5)
  await expect(page.getByRole("heading", { name: "Needs you", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Problems", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What ran", exact: true })).toBeVisible();

  // 3. Automations -> New picker -> Templates showing server readiness (G1/G2/G3)
  await page.getByRole("link", { name: "Automations", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "New", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "New automation", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Templates", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Build with AI", exact: true })).toBeVisible();

  // Pick a template with readiness blockers -> opens generated wizard (#/a/:id)
  await page.getByRole("searchbox", { name: "Search the library" }).fill("Lalamove");
  const card = page.locator(".lib-card").filter({ hasText: "Book a Lalamove rider when an order is confirmed" }).first();
  await expect(card).toContainText("Save your Lalamove API key");
  await card.getByRole("button", { name: /Use this/ }).click();
  await expect(page).toHaveURL(/#\/a\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Answer a few questions", exact: true })).toBeVisible();

  // Edit steps opens List view first in Editor (#/w/:id)
  await page.getByRole("link", { name: "Edit steps", exact: true }).click();
  await expect(page).toHaveURL(/#\/w\/[0-9a-f-]+$/);
  await expect(page.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
  const gotIt = page.getByRole("button", { name: "Got it", exact: true });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();

  // 4. Business tabs & Lalamove app card (G3)
  await page.getByRole("link", { name: "Business", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Business", exact: true })).toBeVisible();
  for (const tab of ["Details and branding", "Knowledge", "Apps", "Team"]) {
    await expect(page.getByRole("navigation", { name: "Business" }).getByRole("link", { name: tab, exact: true })).toBeVisible();
  }
  await page.getByRole("navigation", { name: "Business" }).getByRole("link", { name: "Apps", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lalamove", exact: true })).toBeVisible();

  // 5. Bookings tabs: Calendar + Rooms and slots (G3)
  await page.getByRole("link", { name: "Bookings", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Bookings" }).getByRole("link", { name: "Rooms and slots", exact: true })).toBeVisible();

  // 6. Settings > Advanced (G3)
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Advanced", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Secrets", exact: true })).toBeVisible();

  // 7. Inbox queue & calm empty state (G4)
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Conversations/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Receipts/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Approvals/ })).toBeVisible();
});

test("mobile 390x844 and dark mode across the six destinations have zero horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await registerOwner(page, "g1g5-mob");

  // Switch to Dark mode via Settings
  await page.goto("/#/settings");
  await page.getByRole("radio", { name: "Dark" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  for (const hash of ["#/", "#/inbox", "#/bookings", "#/automations", "#/business", "#/settings"]) {
    await page.goto(`/${hash}`);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `Horizontal overflow on ${hash}`).toBeLessThanOrEqual(1);
  }
});
