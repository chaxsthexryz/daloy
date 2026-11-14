import { expect, test } from "@playwright/test";

// QA-02 at P6a: the owner adds a therapist on the Resources page, and a customer picks the therapist and a time on
// the public form. The server reads the time in the field's zone and stores the therapist with its name (decision 0031).
test("an owner adds a resource and a customer books it on the public form", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`spa-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Resources" }).click();
  await expect(page.getByText("No resources yet.")).toBeVisible();
  await page.getByLabel("Name").fill("Ana");
  await page.getByRole("button", { name: "Add resource" }).click();
  await expect(page.getByRole("cell", { name: "Ana" })).toBeVisible();

  // The builder is covered by main-flow.spec.ts; the form workflow comes from the API with the console session.
  const wf = await (await page.request.post("/workflows", { data: { name: "Spa", slug: `spa-${Date.now()}` } })).json();
  const fields = [
    { name: "therapist", label: "Therapist", type: "resource", required: true },
    { name: "appointment_at", label: "Appointment time", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
  ];
  const definition = { trigger: { type: "form", config: { fields } }, steps: [{ id: "pause", type: "delay", config: { seconds: 1 } }], edges: [] };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  const { trigger } = await (await page.request.get(`/workflows/${wf.id}`)).json();

  const year = new Date().getUTCFullYear() + 1;
  await page.goto(`/forms/${trigger.id}`);
  await expect(page.getByText("Times are in Asia/Manila")).toBeVisible();
  await page.getByLabel("Therapist").selectOption({ label: "Ana" });
  await page.getByLabel("Appointment time").fill(`${year}-01-20T14:00`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Thanks, we received your message.")).toBeVisible();

  const [run] = await (await page.request.get(`/runs?workflowId=${wf.id}`)).json();
  expect(run.triggerPayload).toEqual({ therapist: { id: expect.any(String), name: "Ana" }, appointment_at: `${year}-01-20T14:00:00+08:00` });
});
