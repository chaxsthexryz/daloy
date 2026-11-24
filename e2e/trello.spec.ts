import { expect, test } from "@playwright/test";
import { connectRecord, recorded, recordPanel, sendRecord } from "./records";

test("an owner signs in to Trello, picks an open list and delivers a card", async ({ page }) => {
  const panel = await connectRecord(page, "trello", "Trello");
  await expect(panel.getByLabel("API key", { exact: true })).not.toBeVisible();
  await panel.getByRole("button", { name: "Pick a list" }).click();
  await panel.getByLabel("Board", { exact: true }).selectOption({ label: "Office" });
  await expect(panel.getByLabel("List", { exact: true }).getByRole("option", { name: "Old list", exact: true })).toHaveCount(0);
  await panel.getByLabel("List", { exact: true }).selectOption({ label: "Doing" });
  await panel.getByRole("button", { name: "Save list" }).click();
  await expect(panel).toContainText("Doing");
  await page.reload();
  await expect(recordPanel(page, "Trello")).toContainText("Doing");
  const before = (await recorded()).trelloCards.filter((c) => c.startsWith("Test card from kymavo")).length;
  await recordPanel(page, "Trello").getByRole("button", { name: "Add a test card" }).click();
  await expect(recordPanel(page, "Trello")).toContainText("Trello accepted a test card");
  expect((await recorded()).trelloCards.filter((c) => c.startsWith("Test card from kymavo"))).toHaveLength(before + 1);
  await sendRecord(page, "trello", `Trello request ${Date.now()}`);
});
