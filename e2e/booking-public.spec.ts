import { expect, test } from "@playwright/test";

// Doop row E9 (decision 0080): a visitor picks a resource and an open time, a second visitor loses the same time to the
// first, sees the "no longer available" page with the answers kept, and books another time. The booking is made by the
// real worker through a booking step, so the taken time is a real booking.
test("a visitor picks an open time and recovers when someone else booked it first", async ({ page, browser }) => {
  const year = new Date().getUTCFullYear() + 1;
  expect((await page.request.post("/auth/register", { data: { email: `book-${Date.now()}@test.local`, password: "e2e test password 1" } })).status()).toBe(201);
  expect((await page.request.put("/settings/email/profile", { data: { businessName: "Sampaguita Bakery", website: null, inquiryEmail: null, replyTo: null } })).status()).toBe(204);
  await page.request.post("/resources", { data: { name: "Kitchen table" } });
  const room = await (await page.request.post("/resources", { data: { name: "Tasting room" } })).json();
  const wf = await (await page.request.post("/workflows", { data: { name: "Tastings", slug: `tast-${Date.now()}` } })).json();
  const fields = [
    { name: "email", label: "Your email", type: "email", required: true },
    { name: "room", label: "Resource", type: "resource", required: true },
    { name: "at", label: "Date and time", type: "datetime", required: true, timezone: "Asia/Manila", slotMinutes: 60 },
  ];
  const definition = {
    trigger: { type: "form", config: { fields } },
    steps: [{ id: "book", type: "booking", config: { action: "create", resource: "{{trigger.room}}", start: "{{trigger.at}}", minutes: 60 } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  const formId = ((await (await page.request.get(`/workflows/${wf.id}`)).json()) as { trigger: { id: string } }).trigger.id;

  const open = async () => {
    const context = await browser.newContext();
    const visitor = await context.newPage();
    await visitor.goto(`/forms/${formId}`);
    await visitor.getByLabel("Your email").fill("jo@sampaguita.ph");
    await visitor.getByLabel("Resource").selectOption({ label: "Tasting room" });
    await visitor.getByLabel("Date and time").fill(`${year}-01-20T09:00`);
    return { context, visitor };
  };

  // Both visitors see 10:00 am open and choose it.
  const first = await open();
  const second = await open();
  for (const { visitor } of [first, second]) {
    await expect(visitor.getByText("Open times on")).toBeVisible();
    await expect(visitor.getByRole("button", { name: "10:00 am" })).toBeEnabled();
    await visitor.getByRole("button", { name: "10:00 am" }).click();
    await expect(visitor.getByLabel("Date and time")).toHaveValue(`${year}-01-20T10:00`);
    await expect(visitor.getByRole("button", { name: "10:00 am" })).toHaveAttribute("aria-pressed", "true");
  }

  await first.visitor.getByRole("button", { name: "Send" }).click();
  await expect(first.visitor.getByText("Thanks, we received your message.")).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/bookings")).json()).length, { timeout: 30_000 }).toBe(1);

  // The second visitor's send is refused with the form back, the answers kept and 10:00 am struck out.
  const v = second.visitor;
  await v.getByRole("button", { name: "Send" }).click();
  await expect(v.getByRole("alert")).toContainText("That time is no longer available");
  await expect(v.getByRole("alert")).toContainText("Tasting room is already booked for");
  await expect(v.getByLabel("Your email")).toHaveValue("jo@sampaguita.ph");
  await expect(v.getByLabel("Resource")).toHaveValue(room.id);
  await expect(v.getByRole("button", { name: "10:00 am" })).toBeDisabled();
  await v.getByRole("button", { name: "11:00 am" }).click();
  await v.getByRole("button", { name: "Send" }).click();
  await expect(v.getByText("Thanks, we received your message.")).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/bookings")).json()).length, { timeout: 30_000 }).toBe(2);

  // The other resource is free at 10:00 am: availability is per resource.
  const third = await first.context.newPage();
  await third.goto(`/forms/${formId}`);
  await third.getByLabel("Resource").selectOption({ label: "Kitchen table" });
  await third.getByLabel("Date and time").fill(`${year}-01-20T09:00`);
  await expect(third.getByRole("button", { name: "10:00 am" })).toBeEnabled();
  await first.context.close();
  await second.context.close();
});
