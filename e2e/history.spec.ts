import { expect, test } from "@playwright/test";
import { addStep, openTestSettings } from "./editor-steps";

// Run history and versions: see a run's step input and output, change the flow, diff the versions, roll back.
test("open the run history, diff two versions and roll back", async ({ page }) => {
  // Publish, Run live version and Disconnect ask first (N4a); accept each.
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`history-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto("/#/new");
  await page.getByLabel("Name").fill("History");
  await page.getByRole("button", { name: "Create" }).click();

  // Version 1: one condition step ({{trigger.amount}} gt 100). No outside calls.
  await addStep(page, "condition");
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "is live" })).toHaveText(/Version 1 is live/);

  await openTestSettings(page);
  await page.getByLabel("Sample trigger data (JSON)").fill('{ "amount": 250, "api_key": "do-not-show" }');
  await page.getByRole("button", { name: "Run live version" }).click();
  await expect(page.locator(".run > p").first()).toHaveText(/^succeeded live run/, { timeout: 30_000 });

  // The run page shows the trigger data with the secret-looking field masked, and the step's resolved input.
  await page.getByRole("link", { name: "Open this run in the run history" }).click();
  await expect(page.getByRole("heading", { name: "Run timeline" })).toBeVisible();
  await page.getByText("Details for a technician").click();
  const trigger = page.getByLabel("Trigger data");
  await expect(trigger).toContainText('"amount": 250');
  await expect(trigger).toContainText('"api_key": "[secret]"');
  await expect(trigger).not.toContainText("do-not-show");
  await page.getByText("Input").click();
  await expect(page.getByLabel("Input of condition_1")).toContainText('"left": 250');
  await expect(page.locator(".run")).toContainText("condition_1 → true");

  // The run list links back to the same run.
  // The head's Activity button (the breadcrumb's Activity link comes first) opens this automation's activity.
  await page.getByRole("main").getByRole("link", { name: "Activity" }).last().click();
  await expect(page.getByRole("table")).toContainText("Real run");
  await page.getByLabel("Status").selectOption("test");
  await expect(page.getByText("Nothing has happened yet.")).toBeVisible();

  // Version 2 changes the operator.
  await page.getByRole("navigation", { name: "This automation" }).getByRole("link", { name: "Steps" }).click();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("button", { name: /Condition.*condition_1/ }).first().click();
  await page.getByLabel("Operator").selectOption("lt");
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "is live" })).toHaveText(/Version 2 is live/);

  // The versions page diffs v2 against v1, and a rollback publishes v1's definition as v3.
  await page.getByRole("link", { name: "Versions" }).click();
  await expect(page.getByRole("heading", { name: "Version 2" })).toBeVisible();
  await expect(page.getByLabel("Changes")).toContainText(/Condition · Operator changed\s*is greater than → is less than/);
  await expect(page.getByRole("button", { name: /^Version 2 Live/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Version 1/ }).click();
  await expect(page.getByText("Version 1 compared with")).toBeHidden();
  await page.getByRole("button", { name: "Roll back to v1" }).click();
  await expect(page.getByRole("status").filter({ hasText: "is live" })).toHaveText("Version 3 is live, with the definition of version 1.");
  await expect(page.getByRole("button", { name: /^Version 3 Live/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Version 3 compared with version 2")).toBeVisible();
  await expect(page.getByLabel("Changes")).toContainText(/Condition · Operator changed\s*is less than → is greater than/);

  // An unpublished draft or latest non-live version cannot be rolled back to directly.
  const wfId = /#\/w\/([^/]+)\/versions/.exec(page.url())![1]!;
  const v3 = await (await page.request.get(`/workflows/${wfId}/versions/3`)).json();
  await page.request.post(`/workflows/${wfId}/versions`, { data: { definition: v3.definition, publish: false } });
  await page.reload();
  await page.getByText(/Show draft versions/).click();
  await page.getByRole("button", { name: /^Version 4/ }).click();
  await expect(page.getByRole("button", { name: "Roll back to v4" })).toBeDisabled();
});
