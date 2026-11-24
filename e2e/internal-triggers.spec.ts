import { expect, test } from "@playwright/test";

// G1 (decision 0123): Daloy internal triggers (booking_event) and reusable sub-workflows (sub_workflow + call_workflow).
test("booking cancellation triggers a booking_event automation and call_workflow runs a sub_workflow", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`g1-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  const room = await (await page.request.post("/resources", { data: { name: "Cabana 1" } })).json();
  const year = new Date().getUTCFullYear() + 1;

  // 1. Subscribe a workflow to booking_event: cancelled
  const cancelWatcher = await (await page.request.post("/workflows", { data: { name: "Cancel Watcher", slug: `cancel-watch-${Date.now()}` } })).json();
  const cancelDef = {
    trigger: { type: "booking_event", config: { events: ["cancelled"] } },
    steps: [{ id: "cond", type: "condition", config: { condition: { left: "{{trigger.event}}", op: "eq", right: "cancelled" } } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${cancelWatcher.id}/versions`, { data: { definition: cancelDef, publish: true } })).status()).toBe(201);

  // Confirm a stay and cancel it on Bookings
  const created = await (await page.request.post("/bookings/stays", { data: { resourceId: room.id, checkIn: `${year}-08-10`, nights: 2 } })).json();
  const bookingRef = created.booking.reference as string;

  await page.getByRole("link", { name: "Bookings" }).click();
  const item = page.getByRole("region", { name: "Day agenda" }).getByRole("button", { name: /Cabana 1/ });
  await item.click();
  const card = page.getByRole("region", { name: "Cabana 1" });
  page.once("dialog", (d) => void d.accept());
  await card.getByRole("button", { name: "Cancel booking" }).click();
  await expect(page.getByRole("status").filter({ hasText: "is cancelled" })).toBeVisible();

  await expect.poll(
    async () => {
      const list = await (await page.request.get(`/runs?workflowId=${cancelWatcher.id}`)).json();
      return list[0]?.state;
    },
    { timeout: 20_000 },
  ).toBe("succeeded");
  const cancelRuns = await (await page.request.get(`/runs?workflowId=${cancelWatcher.id}`)).json();
  const cancelDetail = await (await page.request.get(`/runs/${cancelRuns[0].id}`)).json();
  expect(cancelDetail.triggerPayload).toMatchObject({ event: "cancelled", reference: bookingRef, status: "cancelled" });

  // 2. Publish a sub_workflow child and call it from a parent workflow
  const childSlug = `child-flow-${Date.now()}`;
  const child = await (await page.request.post("/workflows", { data: { name: "Child Flow", slug: childSlug } })).json();
  const childDef = {
    trigger: { type: "sub_workflow", config: { fields: [{ name: "guest", label: "Guest", type: "text", required: true }] } },
    steps: [{ id: "check", type: "condition", config: { condition: { left: "{{trigger.guest}}", op: "eq", right: "Ana" } } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${child.id}/versions`, { data: { definition: childDef, publish: true } })).status()).toBe(201);

  const parent = await (await page.request.post("/workflows", { data: { name: "Parent Flow", slug: `parent-flow-${Date.now()}` } })).json();
  const parentDef = {
    trigger: { type: "manual", config: {} },
    steps: [{ id: "call", type: "call_workflow", config: { workflowSlug: childSlug, payload: { guest: "{{trigger.guest}}" } } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${parent.id}/versions`, { data: { definition: parentDef, publish: true } })).status()).toBe(201);
  expect((await page.request.post(`/workflows/${parent.id}/runs`, { data: { payload: { guest: "Ana" } } })).status()).toBe(202);

  await expect.poll(
    async () => {
      const pRuns = await (await page.request.get(`/runs?workflowId=${parent.id}`)).json();
      const cRuns = await (await page.request.get(`/runs?workflowId=${child.id}`)).json();
      return pRuns[0]?.state === "succeeded" && cRuns[0]?.state === "succeeded";
    },
    { timeout: 20_000 },
  ).toBe(true);

  const childRuns = await (await page.request.get(`/runs?workflowId=${child.id}`)).json();
  const childDetail = await (await page.request.get(`/runs/${childRuns[0].id}`)).json();
  expect(childDetail.triggerPayload).toMatchObject({ guest: "Ana", _callChain: [parent.id, child.id] });
});
