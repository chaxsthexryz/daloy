import { expect, test } from "@playwright/test";
import { joinAs, registerOwner } from "./workspace";

// W3: the owner sees every card and the office links; an operator sees no language or office settings. The theme
// choice is kept on the device after a reload.
test("Settings shows the cards for each role and keeps the theme after a reload", async ({ page, browser }) => {
  await registerOwner(page);
  await page.goto("/#/settings");
  await expect(page.getByText("Signed in as owner", { exact: true })).toBeVisible();
  for (const card of ["Language", "Appearance", "Your account", "Plan and usage", "Your office"]) {
    await expect(page.getByRole("region", { name: card })).toBeVisible();
  }
  const office = page.getByRole("region", { name: "Your office" });
  for (const [name, href] of [["Apps", "#/apps"], ["Business", "#/settings/business"], ["Team", "#/team"], ["Resources", "#/resources"], ["AI model", "#/settings/ai"], ["API tokens", "#/tokens"]]) {
    await expect(office.getByRole("link", { name, exact: true })).toHaveAttribute("href", href!);
  }
  await page.getByLabel("Dark").check();
  await page.reload();
  await expect(page.getByLabel("Dark")).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const operator = await joinAs(browser, page, "Operator", { width: 1280, height: 720 });
  await operator.goto("/#/settings");
  await operator.reload();
  await expect(operator.getByText("Signed in as operator", { exact: true })).toBeVisible();
  await expect(operator.getByRole("region", { name: "Appearance" })).toBeVisible();
  await expect(operator.getByRole("region", { name: "Plan and usage" })).toBeVisible();
  await expect(operator.getByRole("region", { name: "Language" })).toHaveCount(0);
  await expect(operator.getByRole("region", { name: "Your office" })).toHaveCount(0);
  await expect(operator.getByText("Language and office settings are managed by the owner.")).toBeVisible();
  // W5: an operator who types #/advanced lands on Automations and sees none of the owner's tools.
  await operator.goto("/#/advanced");
  await expect(operator.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();
  await expect(operator.getByRole("heading", { name: "Advanced", level: 1 })).toHaveCount(0);
  await operator.context().close();
});
