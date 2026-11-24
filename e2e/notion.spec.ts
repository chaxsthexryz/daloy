import { expect, test } from "@playwright/test";
import { connectRecord, recorded, recordPanel, sendRecord } from "./records";

test("an owner signs in to Notion, picks a database and delivers a page", async ({ page }) => {
  const panel = await connectRecord(page, "notion", "Notion");
  await expect(panel.getByLabel("Integration secret")).not.toBeVisible();
  await panel.getByRole("button", { name: "Pick a database" }).click();
  await panel.getByLabel("Database", { exact: true }).selectOption({ label: "Leads" });
  await panel.getByRole("button", { name: "Save database" }).click();
  await expect(panel).toContainText("Leads");
  await page.reload();
  await expect(recordPanel(page, "Notion")).toContainText("Leads");
  const before = (await recorded()).notionPages.length;
  await recordPanel(page, "Notion").getByRole("button", { name: "Add a test page" }).click();
  await expect(recordPanel(page, "Notion")).toContainText("Notion accepted a test page");
  expect((await recorded()).notionPages).toHaveLength(before + 1);
  expect((await recorded()).notionPages.at(-1)).toHaveProperty("Lead name");
  await sendRecord(page, "notion", `Notion request ${Date.now()}`);
});

// Phase N15: connect a Notion database (fake API from e2e/global-setup.ts) and add a test page to it.
test("an owner connects a Notion database and adds a test page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`notion-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.getByRole("link", { name: "Apps" }).first().click();
  await page.getByRole("button", { name: "Connect Notion" }).click();
  await page.getByText("Advanced: use a key or token instead", { exact: true }).click();
  await page.getByLabel("Integration secret").fill(process.env.E2E_NOTION_TOKEN!);
  await page.getByLabel("Database link or id").fill(process.env.E2E_NOTION_DATABASE!);
  await page.locator("details").getByRole("button", { name: "Connect Notion" }).click();
  await expect(page.getByText("Entries are added to")).toBeVisible();
  await expect(page.getByText("Office requests").first()).toBeVisible();

  await page.getByRole("button", { name: "Add a test page" }).click();
  await expect(page.getByText(/Notion accepted a test page/)).toBeVisible();
  const res = await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`);
  expect(JSON.stringify(((await res.json()) as { notionPages: unknown[] }).notionPages)).toContain("Test page from kymavo");
});
