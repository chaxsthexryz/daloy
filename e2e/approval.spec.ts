import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Quoted-printable, as nodemailer sends long lines: drop soft line breaks and decode =XX.
const decodeQp = (s: string) => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** Waits for an email to `to` in the SMTP sink and returns the approval link in it. */
async function approvalLink(to: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const messages = readFileSync(process.env.E2E_MAIL_FILE!, "utf8").split("\n").filter(Boolean).map((l) => decodeQp(JSON.parse(l) as string));
    const link = messages.filter((m) => m.includes(to)).map((m) => /http:\/\/localhost:\d+\/approvals\/[A-Za-z0-9_-]{43}/.exec(m)?.[0]).find(Boolean);
    if (link) return link;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no approval email to ${to}`);
}

// Human approval: the run waits, the approver gets an email, opens the link, approves, and the run carries on.
test("a live run waits for approval, and the emailed link approves it once", async ({ page, context }) => {
  const approver = `boss-${Date.now()}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`approval-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
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
