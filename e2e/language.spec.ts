import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("the owner switches the workspace, receives a local Taglish email, and restores English", async ({ page }) => {
  const email = `language-${Date.now()}@example.test`;
  const account = await page.request.post("/auth/register", { data: { email, password: "language test password" } });
  expect(account.status()).toBe(201);
  await page.goto("/#/settings");
  await expect(page.getByRole("radio", { name: "English" })).toBeChecked();
  await page.getByRole("radio", { name: "Taglish" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "tl");
  await page.reload();
  await expect(page.getByRole("radio", { name: "Taglish" })).toBeChecked();
  await expect(page.getByRole("link", { name: "Mga automation", exact: true }).first()).toBeVisible();
  expect((await page.request.post("/settings/email/test")).status()).toBe(200);
  await expect.poll(() => readFileSync(process.env.E2E_MAIL_FILE!, "utf8").split("\n")
    .filter(line => line.includes(email) && line.includes("Subject: Test email ng kymavo")).length).toBe(1);
  await page.getByRole("radio", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("link", { name: "Automations", exact: true }).first()).toBeVisible();
});
