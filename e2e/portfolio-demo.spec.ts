import { expect, test } from "@playwright/test";

test("a visitor can run and reset the unofficial demo offline on a phone", async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const calls: string[] = [];
  page.on("request", (request) => {
    if (["xhr", "fetch", "ping"].includes(request.resourceType())) calls.push(request.url());
  });
  await page.goto("/#/demo");
  await expect(page).toHaveTitle("Astra Daloy | Office request desk");
  await expect(page.getByText("Unofficial interactive demo", { exact: true })).toBeVisible();
  await context.setOffline(true);
  const issue = page.getByLabel("What needs attention?");
  await issue.fill("");
  await page.getByRole("button", { name: "Submit demo request" }).click();
  await expect(issue).toBeFocused();
  await issue.fill("The projector needs a replacement lamp.");
  await page.getByLabel("Your email").fill("staff@example.org");
  await page.getByRole("button", { name: "Submit demo request" }).dblclick();
  await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Simulated inbox" })).toContainText("staff@example.org");
  await expect(page.getByRole("region", { name: "Simulated inbox" })).toContainText("The projector needs a replacement lamp.");
  await page.getByRole("button", { name: "Manager notification" }).click();
  await expect(page.getByRole("region", { name: "Simulated inbox" })).toContainText("office@example.org");
  await expect(page.getByRole("complementary", { name: "Run history" })).toContainText("3 of 3 complete");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.getByRole("button", { name: "Start again" }).click();
  await expect(issue).toHaveValue("The meeting-room projector won't turn on.");
  await expect(page.getByRole("complementary", { name: "Run history" })).toContainText("0 of 3 complete");
  expect(calls).toEqual([]);
});
