import { expect, test, type Page } from "@playwright/test";

// U5: #/new is the Library. Search, category chips, a preview with a diagram and plain steps, and "Use this" makes a draft.
async function signUp(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`library-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  await page.goto("/#/new");
  await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("search and category chips narrow the cards, and a card previews before it makes a draft", async ({ page }) => {
  await signUp(page, 1280, 800);
  const card = (name: string) => page.getByRole("button", { name: `Preview: ${name}` });

  // Blank workflow and Build with AI come first, then the templates.
  await expect(page.getByRole("heading", { level: 3 }).first()).toHaveText("Blank workflow");
  await expect(page.getByRole("heading", { level: 3 }).nth(1)).toHaveText("Build with AI");
  await expect(page.getByRole("button", { name: /^Preview: / })).toHaveCount(42);

  await page.getByLabel("Search the library").fill("invoice");
  await expect(card("Invoice follow-up")).toBeVisible();
  await expect(card("Invoice with payment link and reminders")).toBeVisible();
  await expect(card("Inquiry triage")).toHaveCount(0);
  await page.getByLabel("Search the library").fill("");

  await page.getByRole("button", { name: "Bookings", exact: true }).click();
  await expect(card("Appointment reminder")).toBeVisible();
  await expect(card("Lead to booking")).toBeVisible();
  await expect(card("Inquiry triage")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Blank workflow" })).toHaveCount(0);
  await page.getByRole("button", { name: "Office", exact: true }).click();
  await expect(card("Track an office request")).toBeVisible();
  await expect(card("Purchase request with approval")).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();

  // Enter on a card opens the preview: a read-only diagram and the steps in words.
  await card("Appointment reminder").press("Enter");
  const preview = page.getByRole("region", { name: "Appointment reminder" });
  await expect(preview.locator(".react-flow")).toBeVisible();
  await expect(preview.getByText(/^Starts when:/)).toBeVisible();
  await expect(preview.getByText(/^1\. /)).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);

  // Use this keeps the name box, makes a draft and opens it.
  await preview.getByLabel("Name").fill("Reminders for clients");
  await preview.getByRole("button", { name: "Use this", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reminders for clients", level: 1 })).toBeVisible();
  await expect(page.locator(".a7-chip")).toHaveText("Draft");
});

test("a card's own Use this makes the draft, and a taken name opens the preview to rename it", async ({ page }) => {
  await signUp(page, 1280, 800);
  await page.getByRole("button", { name: "Use this: Invoice follow-up" }).click();
  await expect(page.getByRole("heading", { name: "Invoice follow-up", level: 1 })).toBeVisible();

  await page.goto("/#/new");
  await page.getByRole("button", { name: "Use this: Invoice follow-up" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "An automation with that name already exists." })).toBeVisible();
  const preview = page.getByRole("region", { name: "Invoice follow-up" });
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
