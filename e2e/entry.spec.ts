import { expect, test, type Page } from "@playwright/test";
import { resetLink } from "./mail";
import { PASSWORD, registerOwner } from "./workspace";

// Doop rows E1 to E6: the signed-out pages and My requests.
const PHONE = { width: 390, height: 844 };
const TOKEN = "A".repeat(43);

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test("E2: a short password is refused before any request and an existing email is named", async ({ page }) => {
  const email = `entry-${Date.now()}@test.local`;
  let sent = 0;
  await page.route("**/auth/register", (route) => (sent++, route.continue()));
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("short pass");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toHaveText("Password must be at least 12 characters.");
  await expect(page.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
  expect(sent).toBe(0);

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  // The same email again, in a fresh browser session.
  const again = await page.context().browser()!.newContext();
  const other = await again.newPage();
  await other.goto("/");
  await other.getByRole("button", { name: "Create an account", exact: true }).click();
  await other.getByLabel("Email").fill(email);
  await other.getByLabel("Password").fill(PASSWORD);
  await other.getByRole("button", { name: "Create account" }).click();
  await expect(other.getByRole("alert")).toHaveText("email already registered");
  await expect(other.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
  await other.getByRole("button", { name: "I have an account" }).click();
  await expect(other.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await again.close();
});

test("E1: a wrong password is named, then the right one signs in", async ({ page }) => {
  const email = `entry-login-${Date.now()}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  await page.context().clearCookies();
  await page.goto("/");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("An approval is waiting for you")).toHaveCount(0);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("not the right password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Wrong email or password.");
  await expect(page.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
});

test("E1: an approval link keeps its destination through sign in", async ({ page }) => {
  const email = `entry-answer-${Date.now()}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  await page.context().clearCookies();

  await page.goto("about:blank");
  await page.goto(`/#/answer/${TOKEN}`);
  await expect(page.getByRole("status")).toContainText("An approval is waiting for you. Sign in with the email it was sent to");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The server page checks that this person is the named approver; the console only hands over.
  await expect(page).toHaveURL(new RegExp(`/approvals/${TOKEN}$`));
});

test("E1 and E2 on a phone: one column, one forgot link, no sideways scroll", async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Forgot your password?" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Forgot your password?" })).toBeVisible();
  await noSideScroll(page);
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  await noSideScroll(page);
  await context.close();
});

test("E3: the same answer for an account that exists and one that does not", async ({ page }) => {
  const known = `entry-known-${Date.now()}@test.local`;
  const stranger = `entry-stranger-${Date.now()}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(known);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  await page.context().clearCookies();

  const answers: string[] = [];
  for (const email of [known, stranger]) {
    await page.goto("about:blank");
    await page.goto("/#/forgot-password");
    await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send link" }).click();
    answers.push((await page.getByRole("status").textContent())!);
    await expect(page.getByRole("link", { name: "Back to sign in" })).toBeVisible();
  }
  expect(answers[0]).toBe(answers[1]);
  expect(answers[0]).toContain("If an account exists for that email");
  await resetLink(known);
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("E4: a reset link works once, a short password is refused, and a reused link says so", async ({ page }) => {
  const email = `entry-reset-${Date.now()}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  await page.context().clearCookies();
  await page.goto("about:blank");
  await page.goto("/#/forgot-password");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page.getByRole("status")).toBeVisible();
  const link = await resetLink(email);

  await page.goto("about:blank");
  await page.goto(link);
  await page.getByLabel(/New password/).fill("too short");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("alert")).toHaveText("Password must be at least 12 characters.");
  await page.getByLabel(/New password/).fill("e2e brand new password 2");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("status")).toHaveText("Password changed. Sign in with your new password.");
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  // The same link a second time: the API refuses it, and the page offers a new one.
  await page.goto("about:blank");
  await page.goto(link);
  await page.getByLabel(/New password/).fill("another brand new password 3");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("alert")).toContainText("this link is not valid");
  await page.getByRole("link", { name: "Send a new link" }).click();
  await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
});

test("E3 and E4 on a phone: no sideways scroll", async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  await page.goto("/#/forgot-password");
  await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
  await noSideScroll(page);
  await page.goto("about:blank");
  await page.goto(`/#/reset-password/${TOKEN}`);
  await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
  await noSideScroll(page);
  await context.close();
});

/** Creates an invite link from the owner's Team page. */
async function inviteLink(owner: Page, email: string, role: "Operator" | "Approver" | "Requester") {
  await owner.goto("/#/team");
  await owner.reload();
  await owner.getByLabel("Email").fill(email);
  await owner.getByLabel("Role", { exact: true }).selectOption({ label: role });
  await owner.getByRole("button", { name: "Create invite link" }).click();
  return (await owner.getByLabel("Invite link").textContent())!.trim();
}

test("E5: a new person joins as the invited role and the link works once", async ({ page, browser }) => {
  await registerOwner(page);
  const link = await inviteLink(page, `entry-operator-${Date.now()}@test.local`, "Operator");

  const joining = await browser.newContext();
  const join = await joining.newPage();
  await join.goto(link);
  await expect(join.getByRole("heading", { name: "Join your team" })).toBeVisible();
  await join.getByLabel(/Password/).fill("too short");
  await join.getByRole("button", { name: "Join" }).click();
  await expect(join.getByRole("alert")).toHaveText("Password must be at least 12 characters.");
  await join.getByLabel(/Password/).fill(PASSWORD);
  await join.getByRole("button", { name: "Join" }).click();
  // An operator gets the console but not the owner's pages.
  await expect(join.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  await join.goto("/#/team");
  await expect(join.getByRole("heading", { name: "Team", exact: true })).toHaveCount(0);

  // The same link in a third browser: used.
  const third = await browser.newContext();
  const again = await third.newPage();
  await again.goto(link);
  await again.getByLabel(/Password/).fill(PASSWORD);
  await again.getByRole("button", { name: "Join" }).click();
  await expect(again.getByRole("alert")).toContainText("this invite is not valid");
  await expect(again.getByLabel(/Password/)).toHaveAttribute("aria-invalid", "true");
  await joining.close();
  await third.close();
});

test("E5: an email that already has an account must enter its own password", async ({ page, browser }) => {
  await registerOwner(page);
  const email = `entry-again-${Date.now()}@test.local`;
  // Join and be removed, so the account exists but belongs to no workspace.
  const first = await inviteLink(page, email, "Requester");
  const ctx = await browser.newContext();
  const joined = await ctx.newPage();
  await joined.goto(first);
  await joined.getByLabel(/Password/).fill(PASSWORD);
  await joined.getByRole("button", { name: "Join" }).click();
  await expect(joined.getByRole("heading", { name: "My requests" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: `Remove ${email}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("button", { name: `Remove ${email}` })).toHaveCount(0);

  const second = await inviteLink(page, email, "Requester");
  const again = await browser.newContext();
  const join = await again.newPage();
  await join.goto(second);
  await join.getByLabel(/Password/).fill("a different password 9");
  await join.getByRole("button", { name: "Join" }).click();
  await expect(join.getByRole("alert")).toHaveText("this email already has an account: enter its password");
  await join.getByLabel(/Password/).fill(PASSWORD);
  await join.getByRole("button", { name: "Join" }).click();
  await expect(join.getByRole("heading", { name: "My requests" })).toBeVisible();
  await ctx.close();
  await again.close();
});

test("E5 on a phone: no sideways scroll", async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  await page.goto(`/#/invite/${TOKEN}`);
  await expect(page.getByRole("heading", { name: "Join your team" })).toBeVisible();
  await noSideScroll(page);
  await context.close();
});
