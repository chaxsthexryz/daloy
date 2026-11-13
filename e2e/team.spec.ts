import { expect, test } from "@playwright/test";
import { approvalLink } from "./mail";

const PASSWORD = "e2e test password 1";

// Named approval (decision 0022): the owner invites an approver, names them on an approval step, and only that
// person, signed in, can answer. A forwarded link shows nothing private and the run records who decided.
test("an invited approver answers a named approval; the owner and a signed-out visitor cannot", async ({ page, context, browser }) => {
  const approver = `approver-${Date.now()}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`owner-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  // Invite the approver from the Team page and join with the link in another browser.
  await page.getByRole("link", { name: "Team" }).click();
  await page.getByLabel("Email").fill(approver);
  await page.getByRole("button", { name: "Create invite link" }).click();
  const invite = (await page.getByLabel("Invite link").textContent())!.trim();
  const joining = await browser.newContext();
  const joinPage = await joining.newPage();
  await joinPage.goto(invite);
  await joinPage.getByLabel(/Password/).fill(PASSWORD);
  await joinPage.getByRole("button", { name: "Join" }).click();
  await expect(joinPage.getByRole("heading", { name: "My requests" })).toBeVisible();
  await joining.close();
  await page.reload();
  await expect(page.getByRole("cell", { name: approver, exact: true })).toBeVisible();

  // An approval step named to them.
  await page.getByRole("link", { name: "Workflows" }).click();
  await page.getByLabel("Name").fill("Named approval");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByLabel("Add a step as the first step").selectOption("approval");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("textbox", { name: "To (comma-separated)" }).fill("");
  await page.getByRole("textbox", { name: /^Approver/ }).fill(approver);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Buy a printer for 300 EUR?");
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status")).toHaveText(/Version 1 is live/);
  await page.getByRole("button", { name: "Run live version" }).click();
  const result = page.locator(".run");
  await expect(result.locator("> p").first()).toHaveText(/^waiting live run/, { timeout: 30_000 });
  const link = await approvalLink(approver);

  // The owner is signed in but is not the named approver.
  const ownerTab = await context.newPage();
  await ownerTab.goto(link);
  await expect(ownerTab.getByText("This approval is assigned to someone else.")).toBeVisible();
  await expect(ownerTab.getByText("Buy a printer")).toHaveCount(0);

  // A signed-out visitor sees no details and no buttons, only a way to sign in.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto(link);
  await expect(otherPage.getByText("This approval is for a named person.")).toBeVisible();
  await expect(otherPage.getByText("Buy a printer")).toHaveCount(0);
  await expect(otherPage.getByRole("button", { name: "Approve" })).toHaveCount(0);

  // The approver signs in from that page and lands back on the approval.
  await otherPage.getByRole("link", { name: "Sign in" }).click();
  await otherPage.getByLabel("Email").fill(approver);
  await otherPage.getByLabel("Password").fill(PASSWORD);
  await otherPage.getByRole("button", { name: "Sign in" }).click();
  await expect(otherPage.getByText(`Signed in as ${approver}`)).toBeVisible();
  await expect(otherPage.getByText("Buy a printer for 300 EUR?")).toBeVisible();
  await otherPage.getByRole("button", { name: "Approve" }).click();
  await expect(otherPage.getByText("Your answer (approved) is recorded.")).toBeVisible();
  await other.close();

  await expect(result.locator("> p").first()).toHaveText(/^succeeded live run/, { timeout: 30_000 });
  await expect(result).toContainText("approval_1 → approved");
  await expect(result).toContainText(`Decided by ${approver}`);
});
