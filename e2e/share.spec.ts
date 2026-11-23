import { expect, test, type Page } from "@playwright/test";

// T5: one Share sheet in the editor, showing only what fits the trigger.
async function signUp(page: Page) {
  const registered = await page.request.post("/auth/register", { data: { email: `share-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`, password: "e2e test password 1" } });
  expect(registered.status()).toBe(201);
}

const step = [{ id: "pause", type: "delay", config: { seconds: 1 } }];

test("a published form shares its link, embed code and MCP tool name; a draft says to publish first", async ({ page, context, baseURL }) => {
  await signUp(page);
  const slug = `contact-${Date.now()}`;
  const wf = await (await page.request.post("/workflows", { data: { name: "Contact us", slug } })).json();
  const definition = { trigger: { type: "form", config: { fields: [{ name: "message", label: "Message", type: "textarea", required: true }] } }, steps: step, edges: [] };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition } })).status()).toBe(201);

  await page.goto(`/#/w/${wf.id}`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share" });
  await expect(sheet).toContainText("Publish first.");
  await sheet.getByRole("button", { name: "Done" }).click();

  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const link = sheet.getByRole("textbox", { name: "Form link" });
  await expect(link).toHaveValue(new RegExp(`/forms/[0-9a-f-]{36}$`));
  await sheet.getByRole("button", { name: "Copy Form link" }).click();
  await expect(sheet.getByRole("status").filter({ hasText: "Copied." })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await link.inputValue());
  await expect(sheet.getByRole("button", { name: "Copy embed code" })).toBeVisible();
  await expect(sheet).toContainText(`as the tool ${slug}`);
  await expect(sheet.getByRole("textbox", { name: "MCP server" })).toHaveValue(/\/mcp$/);
  await expect(sheet.getByText("Webhook URL")).toHaveCount(0);
});

test("a signed webhook shares its URL, the signing rule and a curl call that signs; a manual trigger has no Share", async ({ page }) => {
  await signUp(page);
  expect((await page.request.put("/secrets/hook_key", { data: { value: "whsec_e2e" } })).status()).toBe(204);
  const wf = await (await page.request.post("/workflows", { data: { name: "Orders in", slug: `orders-${Date.now()}` } })).json();
  const definition = { trigger: { type: "webhook", config: { hmacSecret: "hook_key", requireTimestamp: true } }, steps: step, edges: [] };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  const path = (await (await page.request.get(`/workflows/${wf.id}`)).json()).trigger.webhookPath as string;

  await page.goto(`/#/w/${wf.id}`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share" });
  await expect(sheet.getByRole("textbox", { name: "Webhook URL" })).toHaveValue(new RegExp(`/hooks/${path}$`));
  await expect(sheet).toContainText("Calls must be signed with the secret hook_key");
  const curl = sheet.getByRole("textbox", { name: "curl example" });
  await expect(curl).toHaveValue(/X-Daloy-Signature: sha256=\$SIG/);
  await expect(curl).toHaveValue(new RegExp(`/hooks/${path}`));
  await expect(sheet.getByText("AI assistants (MCP)")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Done" }).click();

  const manual = await (await page.request.post("/workflows", { data: { name: "By hand", slug: `hand-${Date.now()}` } })).json();
  expect((await page.request.post(`/workflows/${manual.id}/versions`, { data: { definition: { trigger: { type: "manual", config: {} }, steps: step, edges: [] } } })).status()).toBe(201);
  await page.goto(`/#/w/${manual.id}`);
  await expect(page.getByRole("button", { name: "Explain this flow" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
});
