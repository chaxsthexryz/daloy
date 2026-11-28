import { expect, test, type Page } from "@playwright/test";

// U5: #/new is the Library. Search, category chips, a preview with a diagram and plain steps, and "Use this" makes a draft.
async function signUp(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`library-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.goto("/#/new");
  await expect(page.getByRole("heading", { name: "Templates", level: 1 })).toBeVisible();
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("search and category chips narrow the cards, and a card previews before it makes a draft", async ({ page }) => {
  await signUp(page, 1280, 800);
  const card = (name: string) => page.getByRole("button", { name: `Preview: ${name}` });

  // Templates lists templates with Blank automation in the quiet footer and Build with AI in the head.
  await expect(page.getByRole("link", { name: "Build with AI", exact: true })).toHaveAttribute("href", "#/ai");
  await expect(page.getByRole("heading", { name: "Blank automation" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Preview: / })).toHaveCount(42);

  await page.getByLabel("Search the library").fill("invoice");
  await expect(card("Invoice follow-up")).toBeVisible();
  await expect(card("Invoice with payment link and reminders")).toBeVisible();
  await expect(card("Inquiry triage")).toHaveCount(0);

  // Empty search offers Clear search and Build with AI.
  await page.getByLabel("Search the library").fill("no-template-matches-this");
  await expect(page.getByText("No templates match your search.")).toBeVisible();
  await expect(page.locator(".lib-empty").getByRole("link", { name: "Build with AI" })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(card("Inquiry triage")).toBeVisible();

  // Taglish wording shows a customer message sample on cards.
  await page.getByLabel("Wording:").selectOption("taglish");
  await expect(page.getByText("Sample message").first()).toBeVisible();
  await page.getByLabel("Wording:").selectOption("default");

  await page.getByRole("button", { name: "Bookings", exact: true }).click();
  await expect(card("Appointment reminder")).toBeVisible();
  await expect(card("Lead to booking")).toBeVisible();
  await expect(card("Inquiry triage")).toHaveCount(0);
  await page.getByRole("button", { name: "Office", exact: true }).click();
  await expect(card("Track an office request")).toBeVisible();
  await expect(card("Purchase request with approval")).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();

  // Enter on a card opens the preview dialog with labeled Needs chips; Escape closes it.
  await expect(page.locator(".lib-app-chip").first()).toBeVisible();
  await card("Appointment reminder").press("Enter");
  const preview = page.getByRole("dialog", { name: "Appointment reminder" });
  await expect(preview.locator(".react-flow")).toBeVisible();
  await expect(preview).not.toContainText("React Flow");
  await expect(preview.getByText(/^Starts when:/)).toBeVisible();
  await expect(preview.getByText(/^1\. /)).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await card("Appointment reminder").click();
  await expect(preview).toBeVisible();

  // Use this keeps the name box, makes a draft and opens its wizard (#/a/:id).
  await preview.getByLabel("Name").fill("Reminders for clients");
  await preview.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reminders for clients", level: 1 })).toBeVisible();
  await expect(page.locator(".gp-tag")).toHaveText("Draft");
});

test("a card's own Use this makes the draft, and a taken name opens the preview to rename it", async ({ page }) => {
  await signUp(page, 1280, 800);
  await page.getByRole("button", { name: "Use this: Invoice follow-up" }).click();
  await expect(page.getByRole("heading", { name: "Invoice follow-up", level: 1 })).toBeVisible();

  await page.goto("/#/new");
  await page.getByRole("button", { name: "Use this: Invoice follow-up" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "An automation with that name already exists." })).toBeVisible();
  const preview = page.getByRole("dialog", { name: "Invoice follow-up" });
  await preview.getByLabel("Name").fill("Invoice follow-up 2");
  await preview.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Invoice follow-up 2", level: 1 })).toBeVisible();
});

test("on a phone the cards stack in one column and the preview is a sheet", async ({ page }) => {
  await signUp(page, 390, 844);
  expect(await noSideScroll(page)).toBe(true);
  const first = await page.getByRole("button", { name: "Preview: Inquiry triage" }).boundingBox();
  const second = await page.getByRole("button", { name: "Preview: Invoice follow-up" }).boundingBox();
  expect(Math.abs(first!.x - second!.x)).toBeLessThan(2);

  await page.getByRole("button", { name: "Preview: Inquiry triage" }).click();
  const sheet = page.getByRole("dialog", { name: "Inquiry triage" });
  await expect(sheet.locator(".react-flow")).toBeVisible();
  await expect(sheet.getByText(/^1\. /)).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await sheet.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inquiry triage", level: 1 })).toBeVisible();
});
