import { expect, test } from "@playwright/test";
import { approvalLink } from "./mail";
import { addStep, openTestSettings } from "./editor-steps";

// Human approval: the run waits, the approver gets an email, opens the link, approves, and the run carries on.
test("a live run waits for approval, and the emailed link approves it once", async ({ page, context }) => {
  // Publish, Run live version and Disconnect ask first (N4a); accept each.
  page.on("dialog", (d) => void d.accept());
  const approver = `boss-${Date.now()}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`approval-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  // E10: the approval page carries this workspace's brand, never the Daloy mark.
  expect((await page.request.put("/settings/email/profile", { data: { businessName: "Sampaguita Bakery", website: null, inquiryEmail: null, replyTo: null } })).status()).toBe(204);
  expect((await page.request.put("/settings/brand", { data: { accent: "#1f6b45" } })).status()).toBe(200);
  await page.goto("/#/new");
  await page.getByLabel("Name").fill("Approval");
  await page.getByRole("button", { name: "Create" }).click();

  await addStep(page, "approval");
  await page.getByRole("textbox", { name: "To (comma-separated)" }).fill(approver);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Refund {{trigger.amount}} EUR to Ana?");
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(/Version 1 is live/);

  await openTestSettings(page);
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
  await expect(approverPage.getByText("Sampaguita Bakery")).toBeVisible();
  await expect(approverPage.getByText("Daloy", { exact: true })).toHaveCount(0);
  await expect(approverPage.getByText("Nothing is decided until you choose one of the two buttons.")).toBeVisible();
  await expect(approverPage.getByRole("button", { name: "Approve" })).toHaveCSS("background-color", "rgb(31, 107, 69)");
  await approverPage.setViewportSize({ width: 390, height: 844 });
  expect(await approverPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await approverPage.getByRole("button", { name: "Approve" }).click();
  await expect(approverPage.getByText("Your answer (approved) is recorded.")).toBeVisible();
  await expect(approverPage.getByText("Approved", { exact: true })).toBeVisible();

  // The link works once.
  await approverPage.goto(link);
  await expect(approverPage.getByRole("heading", { name: "Link not valid" })).toBeVisible();
  await expect(approverPage.getByText("This approval link is not valid.")).toBeVisible();
  await expect(approverPage.getByText("Sampaguita Bakery")).toHaveCount(0);

  await expect(result.locator("> p").first()).toHaveText(/^succeeded live run/, { timeout: 30_000 });
  await expect(result).toContainText("approval_1 → approved");
});
