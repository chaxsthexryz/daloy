import { expect, test } from "@playwright/test";

// Picking the AI model: a hosted choice needs a key, the key is kept but never shown again.
test("pick Gemini with a key, then come back and see the key is saved", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`settings-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.getByRole("link", { name: "AI model" }).click();
  await expect(page.getByLabel("Local model")).toBeChecked();
  await page.getByLabel("Gemini API").check();
  await expect(page.getByLabel("Model name")).toHaveValue("gemini-3.8-flash");
  await page.getByLabel("API key").fill("AIza-e2e-not-a-real-key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved. Your workflows now use Gemini API, model gemini-3.8-flash.");

  await page.reload();
  await expect(page.getByLabel("Gemini API")).toBeChecked();
  await expect(page.getByText("key saved; leave empty to keep it")).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("AIza-e2e-not-a-real-key");
});
