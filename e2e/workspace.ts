import { expect, type Browser, type Page } from "@playwright/test";

export const PASSWORD = "e2e test password 1";

export async function registerOwner(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`owner-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
}

/** Invites someone as `role` from the owner's Team page and returns a page signed in as them. */
export async function joinAs(browser: Browser, owner: Page, role: "Operator" | "Requester", viewport: { width: number; height: number }) {
  await owner.goto("/#/team");
  await owner.reload();
  await owner.getByLabel("Email").fill(`${role.toLowerCase()}-${Date.now()}@test.local`);
  await owner.getByLabel("Role", { exact: true }).selectOption({ label: role });
  await owner.getByRole("button", { name: "Create invite link" }).click();
  const link = (await owner.getByLabel("Invite link").textContent())!.trim();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(link);
  await page.getByLabel(/Password/).fill(PASSWORD);
  // Wait for the accept call itself: the sign-in page has an h1 too, so a heading alone can pass before the session exists.
  const accepted = page.waitForResponse((r) => /\/invites\/[^/]+\/accept$/.test(r.url()));
  await page.getByRole("button", { name: "Join" }).click();
  expect((await accepted).ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  return page;
}
