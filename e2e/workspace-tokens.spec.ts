import { expect, test } from "@playwright/test";
import { registerOwner } from "./workspace";

// W8: a scoped, expiring token is shown once with a Copy button, labelled by status, and revoked in a dialog.
// The value is synthetic (the API makes it) and never comes back from the list.
test("API tokens: create, copy once, list and revoke", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await registerOwner(page);
  await page.goto("/#/tokens");
  await page.reload();
  await expect(page.getByRole("heading", { name: "API tokens", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Advanced", exact: true }).first()).toHaveAttribute("href", "#/advanced");
  await expect(page.getByText("0 active")).toBeVisible();
  await expect(page.getByText("None yet.")).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill("Booking sync");
  await page.getByLabel("Start workflows").uncheck();
  await page.getByLabel("Expires").selectOption("30 days");
  await page.getByRole("button", { name: "Create token" }).click();
  const panel = page.getByRole("status");
  await expect(panel.getByRole("heading", { name: "Token created for Booking sync" })).toBeVisible();
  await expect(panel).toContainText("You will not see it again.");
  await expect(panel).toContainText("Access: Read runs and bookings. Expires ");
  const token = (await page.getByLabel("New token").textContent())!.trim();
  expect(token).toMatch(/^dly_/);

  await panel.getByRole("button", { name: "Copy token" }).click();
  await expect(panel.getByText("Copied", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);

  const row = page.getByRole("row").filter({ hasText: "Booking sync" });
  await expect(row.getByText("Active", { exact: true })).toBeVisible();
  await expect(row).toContainText("Read runs and bookings");
  await expect(row).not.toContainText("Start workflows");
  await expect(page.getByText("1 active")).toBeVisible();
  // The list never carries the value.
  expect(await page.evaluate(() => fetch("/tokens").then((r) => r.text()))).not.toContain(token);

  // Shown once: gone after a reload.
  await page.reload();
  await expect(page.getByLabel("New token")).toHaveCount(0);
  expect(await page.content()).not.toContain(token);

  // Revoke asks first. Cancel keeps it; Revoke marks it and drops the count.
  await page.getByRole("button", { name: "Revoke Booking sync" }).click();
  const dialog = page.getByRole("dialog", { name: 'Revoke "Booking sync"?' });
  await expect(dialog).toContainText("a revoked token cannot be turned back on");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Booking sync" }).getByText("Active", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Revoke Booking sync" }).click();
  await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Booking sync" }).getByText("Revoked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke Booking sync" })).toHaveCount(0);
  await expect(page.getByText("0 active")).toBeVisible();

  // Phone: New token is a button that opens a sheet, and the list shows labelled details under each name.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "New token" }).click();
  const sheet = page.getByRole("dialog", { name: "New token" });
  expect((await sheet.boundingBox())!.y).toBeGreaterThan(200);
  await sheet.getByLabel("Name", { exact: true }).fill("Phone check");
  await sheet.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByRole("status").getByRole("heading", { name: "Token created for Phone check" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Phone check" }).locator("td[data-label=\"Access\"]")).toBeVisible();
});
