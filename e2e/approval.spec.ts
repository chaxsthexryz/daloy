import { expect, test } from "@playwright/test";
import { approvalLink } from "./mail";

// Human approval: the run waits, the approver gets an email, opens the link, approves, and the run carries on.
test("a live run waits for approval, and the emailed link approves it once", async ({ page, context }) => {
  // Publish, Run live version and Disconnect ask first (N4a); accept each.
  page.on("dialog", (d) => void d.accept());
  const approver = `boss-${Date.now()}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`approval-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto("/#/advanced");
  await page.getByLabel("Name").fill("Approval");
  await page.getByRole("button", { name: "Create" }).click();

  await page.getByLabel("Add a step as the first step").selectOption("approval");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("textbox", { name: "To (comma-separated)" }).fill(approver);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Refund {{trigger.amount}} EUR to Ana?");
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status")).toHaveText(/Version 1 is live/);

  await page.getByLabel("Sample trigger data (JSON)").fill('{ "amount": 40 }');
  await page.getByRole("button", { name: "Run live version" }).click();
  const result = page.locator(".run");
  await expect(result.locator("> p").first()).toHaveText(/^waiting live run/, { timeout: 30_000 });

  // The approver's side, in a second tab. Opening the link shows the request and records nothing.
  const link = await approvalLink(approver);
  const approverPage = await context.newPage();
  await approverPage.goto(link);
  await expect(approverPage.getByRole("heading", { name: "Approval requested" })).toBeVisible();
  await expect(approverPage.getByText("Refund 40 EUR to Ana?")).toBeVisible();
  await approverPage.getByRole("button", { name: "Approve" }).click();
  await expect(approverPage.getByText("Your answer (approved) is recorded.")).toBeVisible();

  // The link works once.
  await approverPage.goto(link);
  await expect(approverPage.getByText("This approval link is not valid.")).toBeVisible();

  await expect(result.locator("> p").first()).toHaveText(/^succeeded live run/, { timeout: 30_000 });
  await expect(result).toContainText("approval_1 → approved");
});
