import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./workspace";

const PASSWORD = "e2e test password 1";

async function register(page: Page, email: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
}

test("a platform admin opens the admin console at /admin and changes a plan and shared mail; a normal owner gets a 404", async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  const ownerEmail = `admin-target-${Date.now()}@e2e.test`;
  await register(owner, ownerEmail);
  // The old in-app route is an unknown page, and the admin console answers like the admin API.
  await owner.goto("/#/admin");
  await expect(owner.getByRole("heading", { name: "Page not found" })).toBeVisible();
  const api = await owner.request.get("/admin/overview");
  const page = await owner.request.get("/admin");
  expect([api.status(), page.status()]).toEqual([404, 404]);
  expect(await page.json()).toEqual(await api.json());

  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, "platform-admin@e2e.test");
  // The old route sends an admin on to the console, which has its own navigation and no workspace sidebar.
  await admin.goto("/#/admin");
  // A port before the path, so "/#/admin" (no redirect) cannot pass.
  await expect(admin).toHaveURL(/:\d+\/admin$/);
  const nav = admin.getByRole("navigation", { name: "Platform admin" });
  await expect(nav.getByRole("link")).toHaveText(["Overview", "Workspaces", "Runs", "AI models", "Feedback", "Audit log", "Open the workspace console"]);
  await expect(admin.getByRole("link", { name: "Automations" })).toHaveCount(0);
  await expect(admin.getByRole("region", { name: "Totals" })).toContainText("Workspaces");
  await admin.getByRole("link", { name: /^Workspaces/ }).first().click();
  await expect(admin.getByRole("heading", { name: "Workspaces", level: 1 })).toBeVisible();
  const row = admin.getByRole("row").filter({ hasText: ownerEmail });
  await row.getByLabel(`Plan for ${ownerEmail}`).selectOption("business");
  await row.getByLabel(`Shared mail a day for ${ownerEmail}`).fill("25");
  await row.getByRole("button", { name: "Save" }).click();
  await nav.getByRole("link", { name: "Audit log" }).click();
  const log = admin.getByRole("region", { name: "Changes by admins" });
  await expect(log).toContainText(`platform-admin@e2e.test changed the plan of ${ownerEmail}`);
  await expect(log).toContainText(`changed shared mail for ${ownerEmail}, none → 25`);

  // The owner's own usage now reports the plan the admin set.
  expect(await (await owner.request.get("/usage")).json()).toMatchObject({ plan: "business" });
});
