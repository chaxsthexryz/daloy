import { expect, test } from "@playwright/test";

// A7: the Steps editor on a disposable workflow. Trigger, branches, the list view, app setup, a mocked test run, save and publish.
test("edit trigger, steps and branches, then test, save and publish", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`a7-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto("/#/new");
  await page.getByLabel("Name").fill("Receipt approvals");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Receipt approvals", level: 1 })).toBeVisible();
  await expect(page.locator(".a7-chip")).toHaveText("Draft");

  // The list view is the keyboard and screen reader route to every step.
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("button", { name: "Trigger: You run it" }).click();
  await page.getByLabel("Starts when").selectOption("form");
  await expect(page.getByRole("group", { name: "Form fields" })).toBeVisible();

  // An approval with a step on two of its branches.
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await expect(page.getByLabel("Add a step as the first step")).toBeFocused();
  await page.getByLabel("Add a step as the first step").selectOption("approval");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Step 1 · Approval")).toBeVisible();
  await page.getByLabel("Add a step after approval_1").selectOption("email");
  await page.getByLabel("Branch").selectOption("rejected");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: /^approval_1 / }).click();
  await page.getByLabel("Add a step after approval_1").selectOption("sheets");
  await page.getByLabel("Branch").selectOption("approved");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // The sheet needs Google Sheets, which this new workspace has not connected.
  await expect(page.getByText("0 of 1 apps connected")).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect Google Sheet" })).toHaveAttribute("href", "#/apps");
  await expect(page.getByRole("button", { name: /^sheets_1 .*approval_1 on approved/ })).toBeVisible();

  await page.getByRole("button", { name: /^approval_1 / }).click();
  const next = page.getByRole("region", { name: "What happens next" });
  await expect(next).toContainText("approvedsheets_1");
  await expect(next).toContainText("rejectedemail_1");

  // A reference to earlier data copies to the clipboard.
  await page.getByRole("button", { name: /^email_1 / }).click();
  await page.getByRole("button", { name: "Copy {{trigger.email}}" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied {{trigger.email}}");

  // The diagram draws every step; the zoom bar changes the zoom.
  await page.getByRole("button", { name: "Diagram", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(page.locator(".a7-needs-app")).toContainText("Connect Google Sheets");
  // Each node says the app, the action and where it acts (roadmap R2a).
  const sheetNode = page.locator(".a7-node", { hasText: "Add a row" });
  await expect(sheetNode).toContainText("Google Sheets");
  await expect(sheetNode).toContainText("Sheet: chosen in Apps");
  await expect(sheetNode.getByRole("img", { name: "Google Sheets" })).toBeHidden();
  await expect(page.locator(".a7-node", { hasText: "Send email" })).toContainText("To: Email from the form");
  const level = page.locator(".a7-zoom-level");
  const before = await level.textContent();
  await page.getByRole("button", { name: "Zoom Out" }).click();
  await expect(level).not.toHaveText(before!);

  // The header's Test run runs the draft with mocked calls.
  await page.getByRole("button", { name: "Test run", exact: true }).click();
  await expect(page.locator(".run > p").first()).toHaveText(/test run, mocked calls/, { timeout: 30_000 });
  await expect(page.locator(".run")).toContainText("approval_1 → approved");

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").first()).toHaveText(/Saved as version \d+\./);

  // Publishing needs every app connected, so drop the sheet first.
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("button", { name: /^sheets_1 / }).click();
  await page.getByRole("button", { name: "Delete step" }).click();
  await expect(page.getByText("0 of 1 apps connected")).toBeHidden();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status").first()).toHaveText(/Version \d+ is live\./);
  await expect(page.locator(".a7-chip")).toHaveText("Live");
});
