import { expect, test } from "@playwright/test";

// Decision 0064: Connect with Google for Calendar, against the fake Google OAuth app in e2e/global-setup.ts. kymavo makes
// its own "kymavo bookings" calendar after consent, so the owner picks and types nothing.
type FakeEvent = { id: string; status: string; summary?: string };
const events = async () => ((await (await fetch(`${process.env.E2E_PROVIDERS_URL}/__control`)).json()) as { calendarEvents: FakeEvent[] }).calendarEvents;

test("an owner connects Calendar with Google, gets the kymavo bookings calendar, adds a test event and disconnects", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`google-calendar-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  await page.locator("#main-menu").getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("button", { name: "Connect Google Calendar" }).click();
  await expect(page.getByText("Advanced: use a key or token instead")).toBeVisible();
  await expect(page.getByText("use only the calendar kymavo creates")).toBeVisible();
  // The fake consent page answers at once and sends the browser back through the shared callback.
  await page.getByRole("button", { name: "Connect with Google" }).click();
  await expect(page).toHaveURL(/#\/apps\/google-calendar-connected$/);
  await expect(page.getByText("Google Calendar is connected.")).toBeVisible();
  await expect(page.getByText("owner@clinic-e2e.example")).toBeVisible();
  await expect(page.getByText("Events go to")).toBeVisible();
  await expect(page.getByText("kymavo bookings")).toBeVisible();

  const before = (await events()).filter((e) => e.summary === "Test event from kymavo").length;
  await page.getByRole("button", { name: "Add a test event" }).click();
  await expect(page.getByText(/Google Calendar accepted a test event/)).toBeVisible();
  expect((await events()).filter((e) => e.summary === "Test event from kymavo")).toHaveLength(before + 1);

  // Reconnecting with the same Google account keeps the calendar kymavo made.
  await page.getByRole("button", { name: "Reconnect Google Calendar" }).click();
  await expect(page).toHaveURL(/#\/apps\/google-calendar-connected$/);
  await expect(page.getByText("kymavo bookings")).toBeVisible();

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect with Google" })).toBeVisible();
  await expect(page.getByText("owner@clinic-e2e.example")).toBeHidden();
});
