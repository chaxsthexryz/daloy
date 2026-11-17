import { expect, test } from "@playwright/test";

// The public demo (apps/web/demo, decision 0037): scripted helper, real definitions and checker, a run simulated in the page.
test("a visitor builds the shop order automation with the scripted helper and runs a sample offline on a phone", async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const calls: string[] = [];
  page.on("request", (request) => {
    if (["xhr", "fetch", "ping"].includes(request.resourceType())) calls.push(request.url());
  });
  await page.goto("/demo/");
  await expect(page).toHaveTitle("Daloy demo");
  await expect(page.getByText("The AI replies are scripted examples, not a live model.")).toBeVisible();
  await context.setOffline(true);

  await page.getByRole("button", { name: /online-shop order comes in/ }).click();
  await expect(page.getByText("Daloy helper (scripted example)").first()).toBeVisible();
  await page.getByRole("button", { name: "My shop sends a web request" }).click();
  await page.getByRole("button", { name: "Google Sheet" }).click();
  await page.getByRole("button", { name: "Yes, orders over ₱5,000" }).click();
  await expect(page.getByRole("heading", { name: "Check the draft: Online-shop orders" })).toBeFocused();
  await expect(page.getByText("The checker found nothing to fix.")).toBeVisible();
  await page.getByRole("button", { name: "Approve draft" }).click();

  await page.getByRole("button", { name: "Send the test" }).click();
  const inbox = page.getByRole("region", { name: "Simulated inbox" });
  await expect(inbox.getByRole("button", { name: "Approve" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("status")).toContainText("Waiting for your approval");
  await inbox.getByRole("button", { name: "Approve" }).click();
  await expect(inbox).toContainText("To ben@example.com", { timeout: 10_000 });
  await expect(inbox).toContainText("Order 1042 confirmed");
  await expect(page.getByRole("status")).toContainText("Finished. Nothing was sent");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await page.getByRole("button", { name: "Try another example" }).click();
  await page.getByLabel("What should happen?").fill("Post the weather to my blog");
  await page.getByRole("button", { name: "Ask the helper" }).click();
  await expect(page.getByText("This demo has no live model, so it cannot draft what you wrote.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Household bill reminder/ })).toBeVisible();
  expect(calls).toEqual([]);
});
