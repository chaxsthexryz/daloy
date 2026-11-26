import { expect, test } from "@playwright/test";
import { registerOwner } from "./workspace";

// W7: add, rename (in a dialog, not prompt()), archive and restore a resource. Archived rows are marked and counted
// apart from active ones, and the phone shows the same list with the actions under each name.
test("Resources: add, rename, archive and restore with counts", async ({ page }) => {
  await registerOwner(page);
  const row = (name: string) => page.getByRole("row").filter({ hasText: name });
  await page.goto("/#/resources");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Bookings", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Bookings" }).getByRole("link", { name: "Rooms and slots", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Settings", exact: true }).first()).toHaveAttribute("href", "#/settings");
  await expect(page.getByLabel("Room type or label (optional)")).toHaveAttribute("placeholder", "Garden room, Beach villa");
  await expect(page.getByText("No resources yet.")).toBeVisible();

  for (const name of ["Function room", "Table 3 (under repair)"]) {
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Add resource" }).click();
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByText("2 active, 0 archived")).toBeVisible();

  // Archive moves a resource to the archived count and marks the row.
  await row("Table 3 (under repair)").getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("1 active, 1 archived")).toBeVisible();
  const archived = page.getByRole("row", { name: /Table 3/ });
  await expect(archived.getByText("Archived", { exact: true })).toBeVisible();
  await expect(archived.getByRole("cell", { name: "Table 3 (under repair)" })).toHaveCSS("text-decoration-line", "line-through");
  await expect(page.getByRole("row", { name: /Function room/ }).getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("Archived resources leave the forms but keep their record")).toBeVisible();

  // Rename opens a dialog; Cancel changes nothing, Rename saves.
  await row("Function room").getByRole("button", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename Function room" });
  await expect(dialog.getByText("Runs already started keep the old name.")).toBeVisible();
  await expect(dialog.getByLabel("New name")).toHaveValue("Function room");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("cell", { name: "Function room", exact: true })).toBeVisible();
  await row("Function room").getByRole("button", { name: "Rename" }).click();
  await dialog.getByLabel("New name").fill("Function room (upstairs)");
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Function room (upstairs)", exact: true })).toBeVisible();

  // Restore brings the archived one back.
  await row("Table 3 (under repair)").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("2 active, 0 archived")).toBeVisible();

  // Phone: the list stays, and the rename dialog is a sheet at the bottom of the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row("Table 3 (under repair)").getByRole("button", { name: "Archive" })).toBeVisible();
  await row("Function room (upstairs)").getByRole("button", { name: "Rename" }).click();
  const sheet = page.getByRole("dialog", { name: "Rename Function room (upstairs)" });
  await expect(sheet).toBeVisible();
  expect((await sheet.boundingBox())!.y).toBeGreaterThan(300);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});
