import { expect, test, type Page } from "@playwright/test";

// Build a draft in the Build with AI tab (#/ai), save it, then change it in the editor's chat. The e2e stack answers with a fake model.
async function buildDraft(page: Page, prefix: string, description: string, review: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`${prefix}-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.goto("/#/ai");
  await page.getByLabel("What should happen?").fill(description);
  await page.getByRole("button", { name: "Next" }).click();
  for (const label of ["Someone fills a form", "Me", "Email", "No"]) await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByRole("heading", { name: `Check the draft: ${review}` })).toBeVisible();
  await page.getByRole("button", { name: "Save as draft" }).click();
}

test("describe a workflow, save the draft, then ask the AI to change it", async ({ page }) => {
  await buildDraft(page, "ai-draft", "When someone fills my contact form, thank them by email.", "Contact thanks");

  // The editor opens on the draft: trigger plus one step, nothing published yet.
  await expect(page.getByRole("heading", { name: "Contact thanks" })).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.getByLabel("Conversation with the AI")).toContainText("Thanks everyone who fills the contact form.");
  await expect(page.getByText("Version 1, draft")).toBeVisible();

  await page.getByLabel("What should change?").fill("Wait one day before the email.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Conversation with the AI")).toContainText("Waits one day before the thank-you email. Not saved yet.");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "wait_a_day" }).first()).toBeVisible();
});

// The draft is valid but its approval ends the run in silence on reject and timeout, so the editor lists both.
test("the editor warns about an approval with no rejected or timeout branch", async ({ page }) => {
  await buildDraft(page, "ai-lint", "Ask my boss approval, then thank the sender.", "Boss approval");

  const checks = page.getByRole("region", { name: "Check before publishing" });
  await expect(checks).toContainText('Approval step "ask" has no "rejected" edge');
  await expect(checks).toContainText('Approval step "ask" has no "timeout" edge');
});
