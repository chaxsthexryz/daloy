import { expect, test, type Page } from "@playwright/test";
import { base32Decode, totpAt } from "../apps/api/src/totp";
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

test("a platform admin sets up two-factor, opens the admin console at /admin and changes a plan and shared mail; a normal owner gets a 404", async ({ browser }) => {
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
  // First sign-in: two-factor setup before anything else (decision 0158).
  await expect(admin.getByRole("heading", { name: "Set up two-factor sign-in" })).toBeVisible();
  await admin.getByRole("button", { name: "Start setup" }).click();
  const key = (await admin.getByLabel("Setup key").textContent())!.replace(/\s/g, "");
  await expect(admin.getByLabel("Or paste this setup link into an app that takes one:")).toHaveValue(new RegExp(`^otpauth://totp/.+secret=${key}&`));
  await admin.getByLabel("Code from your app").fill(totpAt(base32Decode(key), Date.now()));
  await admin.getByRole("button", { name: "Turn on two-factor sign-in" }).click();
  await expect(admin.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  const recovery = admin.getByRole("list", { name: "Recovery codes" }).getByRole("listitem");
  await expect(recovery).toHaveCount(10);
  const spare = (await recovery.first().textContent())!;
  await expect(admin.getByRole("button", { name: "Copy the codes" })).toBeVisible();
  await admin.getByRole("button", { name: "I saved them" }).click();
  const nav = admin.getByRole("navigation", { name: "Platform admin" });
  await expect(nav.getByRole("link")).toHaveText(["Overview", "Workspaces", "Runs", "AI models", "Feedback", "Audit log", "Open the workspace console"]);
  await expect(admin.getByRole("link", { name: "Automations" })).toHaveCount(0);
  await expect(nav.getByText("2FA on")).toBeVisible();
  await expect(nav.getByRole("button", { name: "Reset 2FA" })).toBeVisible();
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

  // A second sign-in asks for a code; a recovery code works once.
  const again = await (await browser.newContext()).newPage();
  await signIn(again, "platform-admin@e2e.test");
  await again.goto("/admin");
  await expect(again.getByRole("heading", { name: "Enter your two-factor code" })).toBeVisible();
  expect((await again.request.get("/admin/overview")).status()).toBe(403);
  await again.getByRole("button", { name: "Use a recovery code" }).click();
  await again.getByLabel("Recovery code").fill(spare);
  await again.getByRole("button", { name: "Verify" }).click();
  await expect(again.getByRole("navigation", { name: "Platform admin" })).toBeVisible();
  await expect(again.getByRole("region", { name: "Totals" })).toContainText("Workspaces");
});
