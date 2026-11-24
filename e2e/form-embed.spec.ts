import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

test("an owner copies the snippet and a visitor submits it from a second website", async ({ page, context, baseURL }) => {
  const registered = await page.request.post("/auth/register", {
    data: { email: `embed-${Date.now()}@test.local`, password: "e2e test password 1" },
  });
  expect(registered.status()).toBe(201);
  const workflow = await (await page.request.post("/workflows", { data: { name: "Contact us", slug: "contact-us" } })).json();
  const definition = {
    trigger: { type: "form", config: { fields: [{ name: "message", label: "Message", type: "textarea", required: true }] } },
    steps: [{ id: "pause", type: "delay", config: { seconds: 1 } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${workflow.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await page.goto("/");
  await page.getByRole("button", { name: "Contact us" }).click();
  await page.getByRole("button", { name: "Copy embed code" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Embed code copied" })).toBeVisible();
  const snippet = await page.evaluate(() => navigator.clipboard.readText());
  // A different host with no connection to kymavo beyond the HTML an owner copied.
  const site = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(snippet);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  try {
    const website = `http://127.0.0.1:${(site.address() as AddressInfo).port}/contact`;
    await page.goto(website);
    const frame = page.frameLocator("iframe");
    await frame.getByLabel("Message").fill("A visitor from the shop website");
    await frame.getByRole("button", { name: "Send" }).click();
    await expect(frame.getByText("Thanks, we received your message.")).toBeVisible();
    await expect(page).toHaveURL(website);
  } finally {
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
  const runs = await (await page.request.get(`/runs?workflowId=${workflow.id}`)).json();
  expect(runs).toHaveLength(1);
  expect(runs[0].triggerPayload).toEqual({ message: "A visitor from the shop website" });
});
