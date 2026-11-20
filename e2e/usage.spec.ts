import { expect, test } from "@playwright/test";

// The owner's usage view: Settings shows the plan and what has been used.
test("Settings shows Plan and usage with the AI line", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`usage-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Plan and usage" })).toBeVisible();
  await expect(page.getByText(/AI actions: \d+/)).toBeVisible();
});
