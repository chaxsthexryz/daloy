import { expect, test } from "@playwright/test";

// QA-02 at P6a: the owner adds a therapist on the Resources page, and a customer picks the therapist and a time on
// the public form. The server reads the time in the field's zone and stores the therapist with its name (decision 0031).
test("an owner adds a resource and a customer books it on the public form", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`spa-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  // The page's first, empty list answers only after Ana is added. That late answer must not hide her again.
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((r) => (releaseFirst = r));
  let lists = 0;
  await page.route("**/resources", async (route) => {
    if (route.request().method() === "GET" && ++lists === 1) {
      const response = await route.fetch();
      await firstHeld;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await page.getByRole("link", { name: "Advanced" }).click();
  await page.getByRole("link", { name: "Resources" }).click();
  await expect.poll(() => lists).toBe(1);
  await page.getByLabel("Name").fill("Ana");
  await page.getByRole("button", { name: "Add resource" }).click();
  await expect(page.getByRole("cell", { name: "Ana" })).toBeVisible();
  releaseFirst();
  await expect.poll(() => lists).toBe(2);
  await page.waitForTimeout(300);
  await expect(page.getByRole("cell", { name: "Ana" })).toBeVisible();
  await page.unroute("**/resources");

  // The builder is covered by main-flow.spec.ts; the form workflow comes from the API with the console session.
  const wf = await (await page.request.post("/workflows", { data: { name: "Spa", slug: `spa-${Date.now()}` } })).json();
  const fields = [
    { name: "therapist", label: "Therapist", type: "resource", required: true },
    { name: "appointment_at", label: "Appointment time", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
    // Seven minutes does not divide a day, so the server's grid restarts at each local midnight (decision 0031).
    { name: "follow_up", label: "Follow-up time", type: "datetime", required: false, timezone: "Asia/Manila", slotMinutes: 7 },
  ];
  const definition = { trigger: { type: "form", config: { fields } }, steps: [{ id: "pause", type: "delay", config: { seconds: 1 } }], edges: [] };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  const { trigger } = await (await page.request.get(`/workflows/${wf.id}`)).json();

  const year = new Date().getUTCFullYear() + 1;
  await page.goto(`/forms/${trigger.id}`);
  await expect(page.getByText("Times are in Asia/Manila").first()).toBeVisible();
  await page.getByLabel("Therapist").selectOption({ label: "Ana" });
  await page.getByLabel("Appointment time").fill(`${year}-01-20T14:00`);
  // 00:07 is the first slot after midnight on the server's grid; the browser must let it through too.
  await page.getByLabel("Follow-up time").fill(`${year}-01-01T00:07`);
  expect(await page.getByLabel("Follow-up time").evaluate((el: HTMLInputElement) => el.checkValidity())).toBe(true);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Thanks, we received your message.")).toBeVisible();

  const [run] = await (await page.request.get(`/runs?workflowId=${wf.id}`)).json();
  expect(run.triggerPayload).toEqual({ therapist: { id: expect.any(String), name: "Ana" }, appointment_at: `${year}-01-20T14:00:00+08:00`, follow_up: `${year}-01-01T00:07:00+08:00` });
});
