import { expect, test } from "@playwright/test";

// Phase N14: connect a Telegram bot (fake Bot API from e2e/global-setup.ts) and post a message to its chat.
test("an owner connects a Telegram bot and sends a test message", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`tg-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.locator("#main-menu").getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("button", { name: "Connect Telegram" }).click();
  await page.getByLabel("Bot token").fill(process.env.E2E_TELEGRAM_TOKEN!);
  await page.getByLabel("Chat id").fill("-1001234567890");
  await page.getByRole("button", { name: "Connect Telegram" }).click();
  await expect(page.getByText("Messages go to")).toBeVisible();
  await expect(page.getByText("Office team")).toBeVisible();

  await page.getByRole("button", { name: "Send a test message" }).click();
  await expect(page.getByText(/Telegram accepted a test message/)).toBeVisible();
  const res = await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`);
  expect(((await res.json()) as { telegramMessages: string[] }).telegramMessages).toContain("Test message from kymavo.");
});
