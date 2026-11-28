import { expect, test, type Page } from "@playwright/test";

// Decision 0061: "Connect Slack" against the fake install. The fake's authorize endpoint answers with a redirect at once,
// so the browser leaves kymavo and comes back to Apps with the outcome in the address.
const control = async (body?: { slackConsent?: "grant" | "declined" }) => {
  const res = await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`, body ? { method: "POST", body: JSON.stringify(body) } : {});
  return (await res.json()) as { slackMessages: string[]; slackInstalls: number; slackRevokedInstalls: number };
};

async function openSlack(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`slack-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.locator("#main-menu").getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("button", { name: "Connect Slack" }).click();
  return page.getByRole("region", { name: "Slack setup" });
}

test("an owner connects Slack, picks a channel, sends a test message and disconnects", async ({ page }) => {
  const setup = await openSlack(page);
  await expect(setup.getByText("Advanced: use your own Slack app token")).toBeVisible();
  const installs = (await control()).slackInstalls;
  await setup.getByRole("button", { name: "Connect Slack" }).click();

  // Back from Slack: Apps opens on Slack with the outcome shown, and the workspace Slack named.
  await expect(page).toHaveURL(/#\/apps\/slack-connected/);
  await expect(page.getByRole("status").filter({ hasText: "Slack is connected." })).toBeVisible();
  await expect(setup.getByText("Acme Dental")).toBeVisible();
  expect((await control()).slackInstalls).toBe(installs + 1);

  await setup.getByRole("button", { name: "Pick a channel" }).click();
  await setup.getByLabel("Channel", { exact: true }).selectOption({ label: "#office-requests" });
  await setup.getByRole("button", { name: "Save channel" }).click();
  await expect(setup.getByText("Notes go to #office-requests.")).toBeVisible();

  const before = (await control()).slackMessages.length;
  await setup.getByRole("button", { name: "Send a test message" }).click();
  await expect(page.getByText(/Slack accepted a test message/)).toBeVisible();
  expect((await control()).slackMessages).toHaveLength(before + 1);

  // Slack confirmed the revoke, so the page has nothing to tell the owner to do by hand.
  const revoked = (await control()).slackRevokedInstalls;
  page.once("dialog", (d) => void d.accept());
  await setup.getByRole("button", { name: "Disconnect" }).click();
  await expect(setup.getByRole("button", { name: "Connect Slack" })).toBeVisible();
  await expect(setup.getByText("Acme Dental")).toHaveCount(0);
  await expect(setup.getByText(/did not confirm that it removed/)).toHaveCount(0);
  expect((await control()).slackRevokedInstalls).toBe(revoked + 1);
});

test("a declined Slack consent connects nothing and says so", async ({ page }) => {
  const setup = await openSlack(page);
  await control({ slackConsent: "declined" });
  try {
    await setup.getByRole("button", { name: "Connect Slack" }).click();
    await expect(page).toHaveURL(/#\/apps\/slack-declined/);
    await expect(page.getByRole("alert").filter({ hasText: "The permission request was declined" })).toBeVisible();
    await expect(setup.getByRole("button", { name: "Connect Slack" })).toBeVisible();
    await expect(setup.locator("p.in-use")).toHaveCount(0);
  } finally {
    await control({ slackConsent: "grant" });
  }
});
