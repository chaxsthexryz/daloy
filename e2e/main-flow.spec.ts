import { expect, test } from "@playwright/test";
import { addStep, openTestSettings } from "./editor-steps";

// The main flow from CLAUDE.md: sign up, build a two-step flow, test it, publish, run, see it succeed.
test("sign up, build, test-run, publish and run a workflow", async ({ page }) => {
  // Publish, Run live version and Disconnect ask first (N4a); accept each.
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`e2e-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.goto("/#/new");
  await page.getByLabel("Name").fill("Large orders");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Large orders" })).toBeVisible();

  // Step 1: a condition (default: {{trigger.amount}} gt 100). Step 2: an HTTP call on its true branch.
  await addStep(page, "condition");
  await expect(page.getByLabel("Operator")).toHaveValue("gt");
  await addStep(page, "http", { after: "condition_1" });
  await expect(page.getByRole("group", { name: "Condition step condition_1, on true goes to http_1" })).toBeVisible();

  // Test run with mocked calls: the HTTP step answers without a request.
  await openTestSettings(page);
  await page.getByLabel("Sample trigger data (JSON)").fill('{ "amount": 250 }');
  await page.getByRole("button", { name: "Test run draft" }).click();
  const result = page.locator(".run");
  await expect(result.locator("> p").first()).toHaveText(/^succeeded test run, mocked calls/, { timeout: 30_000 });
  await expect(result).toContainText("condition_1 → true");
  await expect(result).toContainText('"mocked": true');

  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(/Version \d+ is live/);

  // A live run that takes the false branch, which has no step, so the test makes no outside call.
  await openTestSettings(page);
  await page.getByLabel("Sample trigger data (JSON)").fill('{ "amount": 50 }');
  await page.getByRole("button", { name: "Run live version" }).click();
  await expect(result.locator("> p").first()).toHaveText(/^succeeded live run/, { timeout: 30_000 });
  await expect(result).toContainText("condition_1 → false");
});

test("the step outline works from the keyboard", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`kb-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.keyboard.press("Enter");
  await page.goto("/#/new");
  // Enter on a card opens its preview; the name box takes the draft's name and Enter in it is not a submit, so press the button.
  await page.getByRole("button", { name: "Preview: Inquiry triage" }).press("Enter");
  const preview = page.getByRole("region", { name: "Inquiry triage" });
  await preview.getByLabel("Name").fill("Keyboard");
  await preview.getByRole("button", { name: "Use this", exact: true }).click();

  await page.getByRole("button", { name: "List", exact: true }).click();
  const step = page.getByRole("button", { name: /^is_billing / });
  await step.focus();
  await page.keyboard.press("Enter");
  await expect(step).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "is_billing" })).toBeVisible();
});
