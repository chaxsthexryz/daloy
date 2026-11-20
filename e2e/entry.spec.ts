import { expect, test, type Page } from "@playwright/test";
import { PASSWORD } from "./workspace";

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
