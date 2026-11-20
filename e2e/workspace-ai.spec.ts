import { expect, test } from "@playwright/test";
import { registerOwner } from "./workspace";

// W6: Save and test against the fake local model shows Working with the label it returned; a model the fake refuses
// shows Not working with the error and what to do next. Nothing leaves the machine, and a saved key stays masked.
test("AI model: a passing test, a failing test and a masked key", async ({ page }) => {
  await registerOwner(page);
  await page.goto("/#/settings/ai");
  await page.reload();
  await expect(page.getByRole("heading", { name: "AI model", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings", exact: true }).first()).toHaveAttribute("href", "#/settings");
  await expect(page.getByLabel("Local model")).toBeChecked();

  await page.getByLabel("Model name", { exact: true }).selectOption("fake-model");
  await page.getByRole("button", { name: "Save and test" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved. Your workflows now use Local model, model fake-model." })).toBeVisible();
  const result = page.getByRole("region", { name: "Test result" });
  await expect(result.getByText("Working", { exact: true })).toBeVisible();
  await expect(result).toContainText("fake-model classified it as billing");
  await expect(result).toContainText("(40 input and 3 output tokens)");

  // A model the fake refuses: the error and the next step show, and the saved setting stays what was saved.
  await page.getByLabel("Model name", { exact: true }).selectOption("Other model…");
  await page.getByLabel("Other model name").fill("fake-broken");
  await page.getByRole("button", { name: "Save and test" }).click();
  await expect(result.getByText("Not working", { exact: true })).toBeVisible();
  await expect(result).toContainText("Not working with fake-broken");
  await expect(result).toContainText("Your workflows keep using this setting until it works");
  await expect(page.locator(".in-use")).toContainText("model fake-broken");

  // Phone: the provider notes fold away, the actions stack, and the same radios still work.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".wk-choice-note").first()).toBeHidden();
  await expect(page.getByRole("button", { name: "Save and test" })).toBeVisible();
  await page.getByRole("radio", { name: /Gemini/ }).check();
  await expect(page.getByLabel("API key")).toHaveValue("");

  // A synthetic key is saved without a test call and is never shown again.
  const KEY = "AIza-e2e-synthetic-key-0001";
  await page.getByLabel("API key").fill(KEY);
  await page.getByRole("button", { name: "Save without testing" }).click();
  await expect(page.getByText("(saved; leave empty to keep it)")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("API key")).toHaveValue("");
  expect(await page.content()).not.toContain(KEY);
  const current = await page.evaluate(() => fetch("/settings/ai").then((r) => r.text()));
  expect(current).not.toContain(KEY);
});
