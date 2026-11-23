import { expect, test } from "@playwright/test";
import { addStep, openTestSettings } from "./editor-steps";

// B1 (decision 0107): add the Read a web page step in the editor and run a mocked test. The mock returns a fixed sample
// page, so no request leaves the machine and the test needs no network.
test("add a Read a web page step and run a test that returns the sample page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`b1-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.goto("/#/new");
  await page.getByLabel("Name").fill("Rice price watch");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Rice price watch" })).toBeVisible();

  await addStep(page, "read_page");
  await page.getByLabel("URL").fill("https://example.com/rice");
  await page.getByLabel("CSS selector").fill(".price");
  await expect(page.getByLabel("Most characters to keep")).toHaveValue("4000");

  // A condition on {{steps.read_page_1.output.changed}} is what turns this into "tell me when the price changes".
  await addStep(page, "condition", { after: "read_page_1" });
  await page.getByLabel("Operator").selectOption("eq");

  await openTestSettings(page);
  await page.getByRole("button", { name: "Test run draft" }).click();
  const result = page.locator(".run");
  await expect(result.locator("> p").first()).toHaveText(/^succeeded test run, mocked calls/, { timeout: 30_000 });
  await expect(result).toContainText("read_page_1");
  await expect(result).toContainText('"mocked": true');
  await expect(result).toContainText('"title": "Sample supplier page"');
  await expect(result).toContainText('"previous": null');
  await expect(result).toContainText('"changed": false');
});
