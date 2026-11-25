import { expect, test, type Browser, type Page } from "@playwright/test";

const PASSWORD = "e2e test password 1";

async function registerOwner(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`owner-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
}

/** Invites `email` from the open Team page and joins with the link in another browser context. */
async function addMember(browser: Browser, page: Page, email: string, role: "Operator" | "Approver" | "Requester") {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Role", { exact: true }).selectOption({ label: role });
  await page.getByRole("button", { name: "Create invite link" }).click();
  const link = (await page.getByLabel("Invite link").textContent())!.trim();
  const joining = await browser.newContext();
  const joinPage = await joining.newPage();
  await joinPage.goto(link);
  await joinPage.getByLabel(/Password/).fill(PASSWORD);
  await joinPage.getByRole("button", { name: "Join" }).click();
  await expect(joinPage.getByRole("heading", { name: "My requests" })).toBeVisible();
  return joining;
}

// W1: members are grouped by role, the owner row has no actions, and Change role and Remove ask in a dialog.
test("the owner invites, changes a role and removes a member from the grouped Team page", async ({ page, browser }) => {
  await registerOwner(page);
  await page.goto("/#/team");
  await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
  await expect(page.getByText("1 member", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Role descriptions" })).toContainText("Operator:");
  const owner = page.locator(".wk-group", { hasText: "Runs the workspace" });
  await expect(owner.getByRole("button")).toHaveCount(0);

  // Pending invites show active origin URL and can copy or revoke links.
  const pendingEmail = `revoke-${Date.now()}@test.local`;
  await page.getByLabel("Email").fill(pendingEmail);
  await page.getByLabel("Role", { exact: true }).selectOption({ label: "Operator" });
  await page.getByRole("button", { name: "Create invite link" }).click();
  const createdLink = (await page.getByLabel("Invite link").textContent())!.trim();
  expect(createdLink.startsWith(new URL(page.url()).origin)).toBe(true);
  const pendingSection = page.getByRole("region", { name: /Pending invites/ });
  await expect(pendingSection.getByText(pendingEmail)).toBeVisible();
  await pendingSection.getByRole("button", { name: `Copy link for ${pendingEmail}` }).click();
  await expect(pendingSection.getByLabel("Copied invite link")).toContainText(new URL(page.url()).origin);
  await pendingSection.getByRole("button", { name: `Revoke invite for ${pendingEmail}` }).click();
  await expect(pendingSection).toHaveCount(0);

  const email = `member-${Date.now()}@test.local`;
  const joined = await addMember(browser, page, email, "Approver");
  await page.reload();
  await expect(page.getByText("2 members", { exact: true })).toBeVisible();
  const approvers = page.getByRole("region", { name: "Approvers · 1" });
  await expect(approvers.getByText(email)).toBeVisible();

  // Change role: Cancel leaves it alone, Save moves the member to another group.
  await approvers.getByRole("button", { name: `Change role of ${email}` }).click();
  await expect(page.getByRole("dialog", { name: `Change role of ${email}` })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Approvers · 1" })).toBeVisible();
  await page.getByRole("button", { name: `Change role of ${email}` }).click();
  await page.getByRole("radio", { name: /Operator/ }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("region", { name: "Operators · 1" }).getByText(email)).toBeVisible();
  await expect(page.getByRole("region", { name: "Approvers · 1" })).toHaveCount(0);

  // Remove asks first; the removed member is signed out.
  await page.getByRole("button", { name: `Remove ${email}` }).click();
  await expect(page.getByRole("dialog", { name: `Remove ${email}?` })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(email)).toBeVisible();
  await page.getByRole("button", { name: `Remove ${email}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText(email)).toHaveCount(0);
  await expect(page.getByText("1 member", { exact: true })).toBeVisible();
  const memberPage = joined.pages()[0]!;
  await memberPage.reload();
  await expect(memberPage.getByRole("heading", { name: "My requests" })).toHaveCount(0);
  await joined.close();
});

// W1 phone: the role button shows the current role, and Remove sits in that sheet.
test("on a phone the role button opens a sheet with Remove, and Invite opens the form", async ({ page, browser }) => {
  await registerOwner(page);
  await page.goto("/#/team");
  const email = `phone-${Date.now()}@test.local`;
  const joined = await addMember(browser, page, email, "Requester");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Invite", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Change role of ${email}` }).click();
  await page.getByRole("button", { name: `Remove ${email}` }).click();
  await expect(page.getByRole("dialog", { name: `Remove ${email}?` })).toBeVisible();
  await expect(page.getByText("They are signed out, and approvals that name them can no longer be answered.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(email)).toBeVisible();
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Invite someone" }).getByLabel("Email")).toBeVisible();
  await joined.close();
});
