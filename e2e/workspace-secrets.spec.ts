import { expect, test } from "@playwright/test";
import { registerOwner } from "./workspace";

const VALUE = "sk-synthetic-secret-value-9021";

// W9: add, replace and delete a synthetic secret. A saved value is never shown, on the page, in the list the API
// returns or in the dialogs. Replace says what it will do, and Delete asks in a dialog that names the secret.
test("Secrets: add, replace, delete, and the value never shows", async ({ page }) => {
  await registerOwner(page);
  await page.goto("/#/apps");
  await expect(page.getByText("SMS (UniSMS) is managed by the kymavo operator")).toBeVisible();
  await page.getByRole("link", { name: "Open Secrets" }).click();
  await expect(page).toHaveURL(/#\/secrets$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Secrets", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Apps", exact: true }).first()).toHaveAttribute("href", "#/apps");
  await expect(page.getByText("None yet.")).toBeVisible();

  for (const name of ["shop_hook", "paymongo_webhook"]) {
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Value", { exact: true }).fill(VALUE);
    await page.getByRole("button", { name: "Save secret" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Saved ${name}. The value is not shown again.` })).toBeVisible();
    await expect(page.getByLabel("Value", { exact: true })).toHaveValue("");
  }
  await expect(page.getByText("2 saved")).toBeVisible();
  await expect(page.getByRole("cell", { name: /^\d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} (AM|PM)$/ })).toHaveCount(2);

  // Replace fills the name, tells what happens to the old value, and keeps one row.
  await page.getByRole("button", { name: "Replace paymongo_webhook" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("paymongo_webhook");
  await expect(page.getByLabel("Value", { exact: true })).toBeFocused();
  await expect(page.getByText("The old value stops working as soon as you save.")).toBeVisible();
  await page.getByLabel("Value", { exact: true }).fill(VALUE + "-new");
  await page.getByRole("button", { name: "Save secret" }).click();
  await expect(page.getByText("2 saved")).toBeVisible();
  await expect(page.getByText("The old value stops working")).toBeHidden();

  // Delete names the secret and says it cannot be recovered; Delete secret removes it.
  await page.getByRole("button", { name: "Delete shop_hook" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete shop_hook?" });
  await expect(dialog).toContainText("the value cannot be recovered");
  await dialog.getByRole("button", { name: "Delete secret" }).click();
  await expect(page.getByRole("cell", { name: "shop_hook", exact: true })).toHaveCount(0);
  await expect(page.getByText("1 saved")).toBeVisible();

  // The value is nowhere: not in the page, not in the API list.
  expect(await page.content()).not.toContain(VALUE);
  expect(await page.evaluate(() => fetch("/secrets").then((r) => r.text()))).not.toContain(VALUE);

  // Phone: Add secret opens a sheet, Replace opens it with the name filled in, and the value field starts empty.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Add secret" }).click();
  const sheet = page.getByRole("dialog", { name: "Save a secret" });
  expect((await sheet.boundingBox())!.y).toBeGreaterThan(200);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.getByRole("button", { name: "Replace paymongo_webhook" }).click();
  const replace = page.getByRole("dialog", { name: "Replace a secret" });
  await expect(replace.getByLabel("Name", { exact: true })).toHaveValue("paymongo_webhook");
  await expect(replace.getByLabel("Value", { exact: true })).toHaveValue("");
  await expect(replace.getByLabel("Value", { exact: true })).toBeFocused();
  expect(await page.content()).not.toContain(VALUE);
});
