import { expect, test } from "@playwright/test";

// N4a: the wizard has a busy lock (a fast double click sent two saves and swallowed a click, the red job on 76defb1),
// Set up for my office reopens the draft instead of adding another, and a failed load says so and offers Retry.
test("a double click on Next and Turn on acts once, setup resumes the draft, and a failed load can be retried", async ({ page, context }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account instead" }).click();
  await page.getByLabel("Email").fill(`dc-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  // Two clicks on Set up for my office make one workflow; starting again later reopens it.
  await page.getByRole("link", { name: "New automation" }).first().click();
  await page.getByRole("link", { name: "Try the preview" }).click();
  const setUp = page.getByRole("button", { name: "Use this template" });
  await setUp.dblclick();
  await expect(page.getByLabel("Automation name")).toBeVisible();
  const workflows = async () => (await (await page.request.get("/workflows")).json()) as { id: string }[];
  expect(await workflows()).toHaveLength(1);
  await page.getByRole("link", { name: "New automation" }).first().click();
  await page.getByRole("link", { name: "Try the preview" }).click();
  await setUp.click();
  await expect(page.getByLabel("Automation name")).toBeVisible();
  expect(await workflows()).toHaveLength(1);

  // A slow save: the second click of a double click must not send a second PATCH or step twice.
  let saves = 0;
  await page.route("**/workflows/*/setup", async (route) => {
    if (route.request().method() === "PATCH") saves++;
    await new Promise((r) => setTimeout(r, 600));
    return route.continue();
  });
  await page.getByRole("button", { name: "Next" }).dblclick();
  await expect(page.getByRole("heading", { name: "Fields staff fill in" })).toBeVisible();
  await expect(page.getByText("Step 2 of 4")).toBeVisible();
  expect(saves).toBe(1);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Where requests and alerts go" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  // The e2e stack's mail server is a local sink, so the owner is told nobody receives the email.
  await expect(page.getByText("Emails go to the local test inbox. Nobody receives them.")).toBeVisible();

  // A slow publish: a double click on Turn on makes one version.
  let publishes = 0;
  await page.route("**/workflows/*/versions", async (route) => {
    if (route.request().method() === "POST") publishes++;
    await new Promise((r) => setTimeout(r, 600));
    return route.continue();
  });
  await page.getByRole("button", { name: "Turn on" }).dblclick();
  await expect(page.getByRole("status")).toContainText("Accepting requests");
  expect(publishes).toBe(1);
  const [wf] = await workflows();
  const versions = (await (await page.request.get(`/workflows/${wf!.id}/versions`)).json()) as unknown[];
  expect(versions).toHaveLength(1);
  await expect(page.getByText("Emails go to the local test inbox. Nobody receives them.")).toBeVisible();

  // One request so there is a run page; its deliveries list fails to load, then Retry loads it.
  const form = await context.newPage();
  await form.goto(await page.locator("code").innerText());
  await form.getByLabel("Your name").fill("Rosa Diaz");
  await form.getByLabel("Your email").fill(`staff-${Date.now()}@test.local`);
  await form.getByLabel("What needs attention?").fill("The printer on floor 2 is jammed.");
  await form.getByRole("button", { name: "Send" }).click();
  await expect(form.getByRole("heading", { name: "Request received" })).toBeVisible();
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByRole("link", { name: "See run history" })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await page.route("**/deliveries*", (route) => route.abort());
  await page.getByRole("link", { name: "See run history" }).click();
  await expect(page.getByText("Couldn't load deliveries.")).toBeVisible();
  await page.unroute("**/deliveries*");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Couldn't load deliveries.")).toBeHidden();
});
