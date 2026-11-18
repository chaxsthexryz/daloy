import { expect, test } from "@playwright/test";

const PASSWORD = "e2e test password 1";
const VALUE = "sk-never-show-me-0123456789";

// N26: secrets are write-only. The value goes in, is cleared at once, and never appears on the page or in what the API returns.
test("an owner adds, replaces and deletes a secret and its value never shows", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`owner-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await page.goto("/#/advanced");
  await page.getByRole("link", { name: "Secrets" }).click();
  await expect(page.getByRole("heading", { name: "Secrets", exact: true })).toBeVisible();

  // A bad name is refused before anything is sent.
  await page.getByLabel("Name").fill("Shop-Hook");
  await page.getByLabel("Value").fill(VALUE);
  await page.getByRole("button", { name: "Save secret" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "a-z" })).toBeVisible();

  await page.getByLabel("Name").fill("shop_hook");
  await page.getByRole("button", { name: "Save secret" }).click();
  await expect(page.getByRole("cell", { name: "shop_hook", exact: true })).toBeVisible();
  await expect(page.getByLabel("Value")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText(VALUE);
  expect(await page.content()).not.toContain(VALUE);
  const listed = await page.evaluate(() => fetch("/secrets").then((r) => r.text()));
  expect(listed).not.toContain(VALUE);

  // Replace: same name, new value; still one row, field cleared again.
  await page.getByRole("button", { name: "Replace shop_hook" }).click();
  await expect(page.getByLabel("Name")).toHaveValue("shop_hook");
  await page.getByLabel("Value").fill(VALUE + "2");
  await page.getByRole("button", { name: "Save secret" }).click();
  await expect(page.getByLabel("Value")).toHaveValue("");
  await expect(page.getByRole("cell", { name: "shop_hook", exact: true })).toHaveCount(1);
  expect(await page.content()).not.toContain(VALUE);

  // Delete asks first: dismissing keeps it, accepting removes it.
  page.once("dialog", (d) => void d.dismiss());
  await page.getByRole("button", { name: "Delete shop_hook" }).click();
  await expect(page.getByRole("cell", { name: "shop_hook", exact: true })).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Delete shop_hook" }).click();
  await expect(page.getByRole("cell", { name: "shop_hook", exact: true })).toHaveCount(0);
});
