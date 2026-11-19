import { expect, test } from "@playwright/test";
import { connectRecord, recordPanel, sendRecord } from "./records";

test("an owner signs in to Airtable, picks a writable table and delivers a record", async ({ page }) => {
  const panel = await connectRecord(page, "airtable", "Airtable");
  await expect(panel.getByLabel("Personal access token")).not.toBeVisible();
  await panel.getByRole("button", { name: "Pick a table" }).click();
  await expect(panel.getByLabel("Base", { exact: true }).getByRole("option", { name: "Read only base", exact: true })).toHaveCount(0);
  await panel.getByLabel("Base", { exact: true }).selectOption({ label: "Office" });
  await panel.getByLabel("Table", { exact: true }).selectOption({ label: "Requests" });
  await panel.getByRole("button", { name: "Save table" }).click();
  await expect(panel).toContainText("Requests");
  await page.reload();
  await expect(recordPanel(page, "Airtable")).toContainText("Requests");
  await recordPanel(page, "Airtable").getByRole("button", { name: "Check the connection" }).click();
  await expect(recordPanel(page, "Airtable")).toContainText("Airtable can read that table");
  await sendRecord(page, "airtable", `Airtable request ${Date.now()}`);
  // Reconnect keeps the target when the same provider account signs in again.
  await Promise.all([
    page.waitForResponse((res) => new URL(res.url()).pathname === "/settings/connections/oauth/callback"),
    recordPanel(page, "Airtable").getByRole("button", { name: "Reconnect Airtable" }).click(),
  ]);
  await expect(recordPanel(page, "Airtable")).toContainText("Airtable is connected.");
  await expect(recordPanel(page, "Airtable")).toContainText("Requests");
});
