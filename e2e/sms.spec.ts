import { expect, test } from "@playwright/test";

// Phase U6 (decision 0100): UniSMS belongs to the server operator. The stack in e2e/global-setup.ts sets the env
// (the fake UniSMS key and Sender ID "DaloyE2E"); a workspace never connects SMS and has no UniSMS card in Apps.
test("SMS comes from the server: no UniSMS card in Apps, the catalog says it is set up, and a live run sends one SMS", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`sms-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.locator("#main-menu").getByRole("link", { name: "Apps", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await expect(page.getByText("Telegram").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "UniSMS" })).toHaveCount(0);

  // The routes that saved a workspace key are gone, and the catalog tells the web app SMS is available.
  expect((await page.request.put("/settings/connections/unisms", { data: { secretKey: "unisms_e2e_workspace_key_1" } })).status()).toBe(404);
  expect((await page.request.post("/settings/connections/unisms/test", { data: { to: "09171230051" } })).status()).toBe(404);
  expect(((await (await page.request.get("/step-schemas")).json()) as { sms: boolean }).sms).toBe(true);

  // An SMS step turns on without any connection, and a live run is sent with the server's Sender ID.
  const wf = (await (await page.request.post("/workflows", { data: { name: "SMS reminder", slug: `sms-reminder-${Date.now()}` } })).json()) as { id: string };
  const definition = {
    trigger: { type: "webhook", config: { fields: [{ name: "phone", label: "Mobile", type: "text", required: true }] } },
    steps: [{ id: "tell", type: "sms", config: { to: "{{trigger.phone}}", message: "Your visit is confirmed.", senderId: "SpoofBrand" } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  const { id } = (await (await page.request.post(`/workflows/${wf.id}/runs`, { data: { payload: { phone: "09171230051" } } })).json()) as { id: string };
  await expect.poll(async () => ((await (await page.request.get(`/runs/${id}`)).json()) as { state: string }).state, { timeout: 30_000 }).toBe("succeeded");
  await expect
    .poll(
      async () => {
        const res = (await (await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`)).json()) as { unismsMessages: { recipient: string; content: string; senderId: string }[] };
        return res.unismsMessages.filter((m) => m.recipient === "+639171230051").map((m) => `${m.content}|${m.senderId}`);
      },
      { timeout: 20_000 },
    )
    .toEqual(["Your visit is confirmed.|DaloyE2E"]);
});
