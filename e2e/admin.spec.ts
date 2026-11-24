import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "e2e admin password 1";

async function register(page: Page, email: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
}

test("a platform admin sees every workspace and changes a plan and shared mail; a normal owner sees no admin page", async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  const ownerEmail = `admin-target-${Date.now()}@e2e.test`;
  await register(owner, ownerEmail);
  await owner.goto("/#/admin");
  await expect(owner.getByText("This page does not exist.")).toBeVisible();
  await expect(owner.getByRole("heading", { name: "Platform admin" })).toHaveCount(0);
  expect((await owner.request.get("/admin/overview")).status()).toBe(404);

  const admin = await (await browser.newContext()).newPage();
  await register(admin, "platform-admin@e2e.test");
  await admin.goto("/#/admin");
  await expect(admin.getByRole("heading", { name: "Platform admin" })).toBeVisible();
  await expect(admin.getByRole("region", { name: "Totals" })).toContainText("Workspaces");
  const row = admin.getByRole("row").filter({ hasText: ownerEmail });
  await row.getByLabel(`Plan for ${ownerEmail}`).selectOption("business");
  await row.getByLabel(`Shared mail a day for ${ownerEmail}`).fill("25");
  await row.getByRole("button", { name: "Save" }).click();
  const log = admin.getByRole("region", { name: "Changes by admins" });
  await expect(log).toContainText(`platform-admin@e2e.test changed the plan of ${ownerEmail}`);
  await expect(log).toContainText(`changed shared mail for ${ownerEmail}, none → 25`);

  // The owner's own usage now reports the plan the admin set.
  expect(await (await owner.request.get("/usage")).json()).toMatchObject({ plan: "business" });
});
