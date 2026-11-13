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
  // Every suggested model is in the list, and "Other model…" opens a text box.
  const modelList = page.getByLabel("Model name", { exact: true });
  await expect(modelList.locator("option")).toHaveText(["gemini-3.8-flash (free)", "gemini-3.6-flash (free)", "gemini-3.5-flash-lite (free)", "gemini-4-hydrogen (free)", "Other model…"]);
  await expect(page.getByText("Free tier. Built for agents and complex workflows.")).toBeVisible();
  await modelList.selectOption("Other model…");
  await page.getByLabel("Other model name").fill("gemini-custom-test");
  await modelList.selectOption("gemini-3.5-flash-lite");
  await expect(page.getByLabel("Other model name")).toBeHidden();
  await expect(page.getByText("Fastest and cheapest.")).toBeVisible();
  await modelList.selectOption("gemini-3.8-flash");
  await expect(page.getByRole("link", { name: "Get a free key in Google AI Studio" })).toHaveAttribute("href", "https://aistudio.google.com/apikey");
  await page.getByLabel("API key").fill("AIza-e2e-not-a-real-key");
  // "Save without testing", so the test never calls Google with the fake key.
  await page.getByRole("button", { name: "Save without testing" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved. Your workflows now use Gemini API, model gemini-3.8-flash.");
  await expect(page.locator(".in-use")).toContainText("In use: Gemini API, model gemini-3.8-flash");

  await page.reload();
  await expect(page.getByLabel("Gemini API")).toBeChecked();
  await expect(page.getByText("(saved; leave empty to keep it)")).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("AIza-e2e-not-a-real-key");

  // Switch to the local model and back: the Gemini key is still saved.
  await page.getByLabel("Local model").check();
  await page.getByRole("button", { name: "Save without testing" }).click();
  await expect(page.locator(".in-use")).toContainText("In use: Local model");
  await page.getByLabel("Gemini API").check();
  await expect(page.getByText("(saved; leave empty to keep it)")).toBeVisible();
  await page.getByRole("button", { name: "Save without testing" }).click();
  await expect(page.locator(".in-use")).toContainText("In use: Gemini API");
});
