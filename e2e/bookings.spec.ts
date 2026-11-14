import { expect, test } from "@playwright/test";

// P6b: a booking made by a workflow run shows on the Bookings page, where staff move it to another time and cancel it
// (decision 0032). The workflow comes from the API with the console session; the builder is covered elsewhere.
test("staff reschedule and cancel a booking on the Bookings page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`desk-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toBeVisible();

  const ana = await (await page.request.post("/resources", { data: { name: "Ana" } })).json();
  const wf = await (await page.request.post("/workflows", { data: { name: "Spa", slug: `spa-${Date.now()}` } })).json();
  const fields = [
    { name: "who", label: "Therapist", type: "resource", required: true },
    { name: "at", label: "Appointment", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
  ];
  const definition = {
    trigger: { type: "webhook", config: { fields } },
    steps: [
      { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.who}}", start: "{{trigger.at}}", minutes: 60 } },
      { id: "wait", type: "delay", config: { until: "{{steps.book.output.start}}", offsetSeconds: -86_400 } },
    ],
    edges: [{ from: "book", to: "wait", on: "done" }],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  const year = new Date().getUTCFullYear() + 1;
  expect((await page.request.post(`/workflows/${wf.id}/runs`, { data: { payload: { who: ana.id, at: `${year}-01-20T14:00` } } })).status()).toBe(202);

  // The worker books it in the background.
  await expect.poll(async () => (await (await page.request.get("/bookings")).json()).length, { timeout: 20_000 }).toBe(1);
  await page.getByRole("link", { name: "Bookings" }).click();
  const row = page.getByRole("row", { name: /Ana/ });
  await expect(row).toContainText(`${year}-01-20 14:00 to 15:00`);
  await row.getByRole("button", { name: "Reschedule" }).click();
  await page.getByLabel("New time (Asia/Manila)").fill(`${year}-01-20T16:00`);
  await page.getByRole("button", { name: "Move" }).click();
  await expect(page.getByRole("status")).toContainText(`moved to ${year}-01-20 16:00`);
  await expect(row).toContainText(`${year}-01-20 16:00 to 17:00`);

  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("status")).toContainText("is cancelled");
  await expect(row).toContainText("cancelled");
});
