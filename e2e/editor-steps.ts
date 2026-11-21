import { expect, type Page } from "@playwright/test";

/**
 * U2: adds a step through the add menu, as a person would. With nothing in the flow it uses "+ Add a step at the end"; with `after`
 * it uses "Add a step after this one" in the panel of that step, which must be selected (a newly added step is). `branch` picks the
 * branch in the menu.
 */
export async function addStep(page: Page, type: string, { after, branch }: { after?: string; branch?: string } = {}) {
  await page.getByRole("button", { name: after ? "Add a step after this one" : "Add a step at the end" }).click();
  const menu = page.getByRole("dialog", { name: after ? `Add a step after ${after}` : /^Add a step / });
  if (branch) await menu.getByLabel("Branch").selectOption(branch);
  await menu.locator(`[data-type="${type}"]`).click();
  await expect(menu).toHaveCount(0);
}

/** U2: the sample data, test calls and Run live version sit in "Test settings", shown when no step is selected. */
export async function openTestSettings(page: Page) {
  const close = page.locator(".a7-panel").getByRole("button", { name: "Close", exact: true });
  if (await close.isVisible()) await close.click();
  const details = page.locator("details.a7-test-settings");
  if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
}
