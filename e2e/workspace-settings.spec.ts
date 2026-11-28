import { expect, test } from "@playwright/test";
import { joinAs, registerOwner } from "./workspace";

// W3: the owner sees every card and the office links; an operator sees no language or office settings. The theme
// choice is kept on the device after a reload.
test("Settings shows the cards for each role and keeps the theme after a reload", async ({ page, browser }) => {
  await registerOwner(page);
  await page.goto("/#/settings");
  await expect(page.locator(".wk-head").getByText(/· Owner$/)).toBeVisible();
  for (const card of ["Account & Security", "Language", "Appearance", "Plan and usage", "Advanced"]) {
    await expect(page.getByRole("region", { name: card })).toBeVisible();
  }
  const advanced = page.getByRole("region", { name: "Advanced" });
  for (const [name, href] of [["Secrets", "#/secrets"], ["All automations", "#/automations"]]) {
    await expect(advanced.getByRole("link", { name, exact: true })).toHaveAttribute("href", href!);
  }
  await expect(advanced.getByRole("link", { name: "API tokens", exact: true })).toHaveCount(0);
  await expect(advanced.getByRole("link", { name: "AI model", exact: true })).toHaveCount(0);
  await page.getByLabel("Dark").check();
  await page.reload();
  await expect(page.getByLabel("Dark")).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.goto("/#/settings/ai");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByText(/AI model settings are managed/)).toBeVisible();

  const operator = await joinAs(browser, page, "Operator", { width: 1280, height: 720 });
  await operator.goto("/#/settings");
  await operator.reload();
  await expect(operator.locator(".wk-head").getByText(/· Operator$/)).toBeVisible();
  await expect(operator.getByRole("region", { name: "Appearance" })).toBeVisible();
  await expect(operator.getByRole("region", { name: "Plan and usage" })).toBeVisible();
  await expect(operator.getByRole("region", { name: "Language" })).toHaveCount(0);
  await expect(operator.getByRole("region", { name: "Advanced" })).toHaveCount(0);
  await expect(operator.getByText("Language and office settings are managed by the owner.")).toBeVisible();
  // W5: an operator who types #/advanced lands on Automations and sees none of the owner's tools.
  await operator.goto("/#/advanced");
  await expect(operator.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
  await expect(operator.getByRole("heading", { name: "Advanced", level: 1 })).toHaveCount(0);
  await operator.context().close();
});
