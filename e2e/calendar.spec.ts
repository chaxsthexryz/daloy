import { expect, test } from "@playwright/test";

// Phase N13: a booking made by a workflow gets a Google Calendar event (fake Calendar API from e2e/global-setup.ts);
// staff move the booking and the event moves, staff cancel it and the event is removed and its reminder stops (decision 0044).
type FakeEvent = { id: string; status: string; summary?: string; start?: { dateTime: string; timeZone?: string } };
const events = async () => ((await (await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`)).json()) as { calendarEvents: FakeEvent[] }).calendarEvents;

test("a booking's calendar event is created, moved and removed with the booking", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`cal-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Apps" }).first().click();
  await page.getByRole("button", { name: "Connect Google Calendar" }).click();
  await page.getByLabel("Service account key file (JSON)").fill(process.env.E2E_SHEETS_KEY!);
  await page.getByLabel("Calendar id").fill(process.env.E2E_CALENDAR_ID!);
  await page.getByRole("button", { name: "Connect Google Calendar" }).click();
  await expect(page.getByText("Events go to")).toBeVisible();
  await expect(page.getByText("Clinic bookings")).toBeVisible();

  const guest = `Guest ${Date.now()}`;
  const ana = await (await page.request.post("/resources", { data: { name: "Ana" } })).json();
  const wf = await (await page.request.post("/workflows", { data: { name: "Spa", slug: `spa-${Date.now()}` } })).json();
  const fields = [
    { name: "who", label: "Therapist", type: "resource", required: true },
    { name: "at", label: "Appointment", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
    { name: "guest", label: "Guest", type: "text", required: true },
  ];
  const definition = {
    trigger: { type: "webhook", config: { fields } },
    steps: [
      { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.who}}", start: "{{trigger.at}}", minutes: 60 } },
      { id: "calendar", type: "calendar", config: { title: "Massage for {{trigger.guest}}", description: "Booking {{steps.book.output.reference}}" } },
      { id: "reminder", type: "delay", config: { until: "{{steps.book.output.start}}", offsetSeconds: -86_400 } },
    ],
    edges: [
      { from: "book", to: "calendar", on: "done" },
      { from: "calendar", to: "reminder" },
    ],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  const year = new Date().getUTCFullYear() + 1;
  expect((await page.request.post(`/workflows/${wf.id}/runs`, { data: { payload: { who: ana.id, at: `${year}-01-20T14:00`, guest } } })).status()).toBe(202);

  const mine = async () => (await events()).filter((e) => e.summary === `Massage for ${guest}`);
  await expect.poll(async () => (await mine()).length, { timeout: 30_000 }).toBe(1);
  expect((await mine())[0]).toMatchObject({ status: "confirmed", start: { dateTime: `${year}-01-20T06:00:00.000Z`, timeZone: "Asia/Manila" } });

  await page.getByRole("link", { name: "Bookings" }).click();
  const row = page.getByRole("row", { name: /Ana/ });
  await row.getByRole("button", { name: "Reschedule" }).click();
  await page.getByLabel("New time (Asia/Manila)").fill(`${year}-01-20T16:00`);
  await page.getByRole("button", { name: "Move" }).click();
  await expect(row).toContainText(`${year}-01-20 16:00 to 17:00`);
  await expect.poll(async () => (await mine())[0]?.start?.dateTime, { timeout: 30_000 }).toBe(`${year}-01-20T08:00:00.000Z`);
  expect(await mine()).toHaveLength(1);

  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(row).toContainText("cancelled");
  await expect.poll(async () => (await mine())[0]?.status, { timeout: 30_000 }).toBe("cancelled");
  expect(await mine()).toHaveLength(1);

  // The reminders that were waiting for the moved booking are closed, so none can go out for the cancelled one.
  const runs = (await (await page.request.get(`/runs?workflowId=${wf.id}`)).json()) as { superseded: boolean }[];
  expect(runs.length).toBeGreaterThan(0);
  expect(runs.every((r) => r.superseded)).toBe(true);
});
