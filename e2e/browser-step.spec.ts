import { expect, test } from "@playwright/test";
import { addStep } from "./editor-steps";

// Phase B2 (decision 0108): the browser step added in the editor, its actions edited, and a mocked test run that lists
// what it would do. A test run opens no page, so this stack needs no browser service.
test("add a browser step, edit its actions and see a mocked test run's would-do lines", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`browser-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto("/#/new");
  await page.getByLabel("Name").fill("Supplier price");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Supplier price", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "List", exact: true }).click();
  await addStep(page, "browser");
  await expect(page.getByText(/Step 1 · browser_1/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Use a web page", exact: true })).toBeVisible();

  await page.getByLabel("URL", { exact: true }).fill("https://supplier.example.com/item/42");
  // The new step reads the h1 into "heading"; point it at the price instead.
  await page.getByLabel("Action 1 Selector").fill(".price");
  await page.getByLabel("Action 1 Name").fill("price");
  await page.getByRole("button", { name: "Add action" }).click();
  await page.getByLabel("Action 2", { exact: true }).selectOption("click");
  await page.getByLabel("Action 2 Visible text").fill("Show stock");
  await page.getByRole("button", { name: "Add action" }).click();
  await page.getByLabel("Action 3", { exact: true }).selectOption("screenshot");

  await page.getByRole("button", { name: "Test run", exact: true }).click();
  await expect(page.locator(".run > p").first()).toHaveText(/test run, mocked calls/, { timeout: 30_000 });
  const output = page.getByLabel("Output of browser_1");
  await expect(output).toContainText("Would open https://supplier.example.com/item/42");
  await expect(output).toContainText("Would read .price into price");
  await expect(output).toContainText('Would click the element with the text \\"Show stock\\"');
  await expect(output).toContainText("Would take a screenshot");

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").first()).toHaveText(/Saved as version \d+\./);
});
