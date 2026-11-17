import { expect, test } from "@playwright/test";

// Phase N15: connect a Notion database (fake API from e2e/global-setup.ts) and add a test page to it.
test("an owner connects a Notion database and adds a test page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`notion-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.getByRole("link", { name: "Apps" }).first().click();
  await page.getByRole("button", { name: "Connect Notion" }).click();
  await page.getByLabel("Integration secret").fill(process.env.E2E_NOTION_TOKEN!);
  await page.getByLabel("Database link or id").fill(process.env.E2E_NOTION_DATABASE!);
  await page.getByRole("button", { name: "Connect Notion" }).click();
  await expect(page.getByText("Entries are added to")).toBeVisible();
  await expect(page.getByText("Office requests").first()).toBeVisible();

  await page.getByRole("button", { name: "Add a test page" }).click();
  await expect(page.getByText(/Notion accepted a test page/)).toBeVisible();
  const res = await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`);
  expect(JSON.stringify(((await res.json()) as { notionPages: unknown[] }).notionPages)).toContain("Test page from Daloy");
});
