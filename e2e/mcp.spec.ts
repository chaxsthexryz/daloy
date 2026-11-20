import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test } from "@playwright/test";

const connect = async (token: string) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3100/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
};

// An MCP client starts a published form workflow with a token made in the console, and loses access when it is revoked.
test("create an API token, run a workflow as an MCP tool, then revoke the token", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`mcp-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  // The builder is covered by main-flow.spec.ts; here the workflow comes from the API with the console session.
  const slug = `contact-${Date.now()}`;
  const wf = await (await page.request.post("/workflows", { data: { name: "Contact form", slug } })).json();
  const definition = {
    trigger: { type: "form", config: { fields: [{ name: "email", label: "Email", type: "email", required: true }] } },
    steps: [{ id: "pause", type: "delay", config: { seconds: 1 } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);

  await page.getByRole("link", { name: "Advanced" }).click();
  await page.getByRole("link", { name: "API tokens" }).click();
  await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();
  await page.getByLabel("Name").fill("e2e client");
  await page.getByRole("button", { name: "Create token" }).click();
  const token = (await page.getByLabel("New token").textContent())!.trim();
  expect(token).toMatch(/^dly_/);

  const client = await connect(token);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain(slug);
  const started = await client.callTool({ name: slug, arguments: { email: "ana@example.com" } });
  const { runId } = started.structuredContent as { runId: string };
  await expect
    .poll(async () => ((await client.callTool({ name: "get_run_status", arguments: { runId } })).structuredContent as { status: string }).status, { timeout: 30_000 })
    .toBe("succeeded");
  await client.close();

  await page.reload();
  await expect(page.getByRole("cell", { name: "never" })).toHaveCount(0);
  await page.getByRole("button", { name: "Revoke e2e client" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByText(/^Revoked/)).toBeVisible();
  await expect(connect(token)).rejects.toThrow();
});
