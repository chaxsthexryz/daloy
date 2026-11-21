import { expect, test, type Page } from "@playwright/test";

// N4d: New automation from the top, search and state filters, drafts apart with Delete, the Activity table on desktop and
// run errors without step ids. Nothing leaves the machine: the failing step is a number check on a missing value.
async function signUp(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`nav-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
}

async function publish(page: Page, name: string, steps: object[]) {
  const wf = await (await page.request.post("/workflows", { data: { name, slug: `${name.toLowerCase()}-${Date.now()}` } })).json();
  const definition = { trigger: { type: "manual", config: {} }, steps, edges: [] };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  return wf.id as string;
}

test("an owner starts from the top button, narrows the list, deletes a draft and reads a failed run", async ({ page }) => {
  await signUp(page);
  const broken = await publish(page, "Broken", [{ id: "check", type: "condition", config: { condition: { left: "{{trigger.amount}}", op: "gt", right: 100 } } }]);
  await publish(page, "Fine", [{ id: "pause", type: "delay", config: { seconds: 1 } }]);
  const run = await (await page.request.post(`/workflows/${broken}/runs`, { data: { payload: {} } })).json();

  // The header button opens New automation, and a guided template reaches its first step (which makes a draft).
  await page.reload();
  await page.getByRole("main").getByRole("link", { name: "New automation" }).click();
  await expect(page).toHaveURL(/#\/new$/);
  await page.getByRole("button", { name: "Use this: Track an office request" }).click();
  await expect(page.getByLabel("Automation name")).toBeVisible();

  // Problem filter and search, with the failed automation sorted first.
  await page.getByRole("link", { name: "Automations", exact: true }).first().click();
  const rows = page.locator("tbody tr.ops-row");
  await expect(async () => {
    await page.reload();
    await expect(rows.first()).toContainText("Problem", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await page.getByLabel("Status:").selectOption("problem");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Broken");
  await page.getByLabel("Status:").selectOption("all");
  await page.getByLabel("Find an automation").fill("fin");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Fine");
  await page.getByLabel("Find an automation").fill("");

  // The draft is a row with the status Draft; its panel has Continue setup and Delete.
  await expect(rows).toHaveCount(3);
  await page.getByLabel("Status:").selectOption("draft");
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole("button").click();
  await expect(page.getByRole("link", { name: "Continue setup" })).toHaveAttribute("href", /#\/a\//);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(rows).toHaveCount(0);
  expect(await (await page.request.get("/workflows")).json()).toHaveLength(2);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows).toHaveCount(2);

  // On desktop the Activity table is a table: its heading row sits above the first row, at the same left edge.
  await page.goto(`/#/w/${broken}/runs`);
  const th = page.locator("table thead th").first();
  const td = page.locator("table tbody td").first();
  await expect(td).toBeVisible();
  const [h, d] = [(await th.boundingBox())!, (await td.boundingBox())!];
  expect(Math.abs(h.x - d.x)).toBeLessThan(2);
  expect(h.y).toBeLessThan(d.y);

  // The run's error is shown without the step id; the full text stays for a technician.
  // The raw error shows first and N10a's "Why it stopped" panel replaces it once the explanation loads, so wait for that load.
  const explained = page.waitForResponse((r) => r.url().includes(`/runs/${run.id}/explanation`), { timeout: 30_000 });
  await page.goto(`/#/runs/${run.id}`);
  await explained;
  const error = page.locator('section[aria-label="Why it stopped"], main > .message.error').first();
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).not.toContainText("step check:");
  await expect(page.getByText("Retry runs the failed step again.")).toBeVisible();
});

test("Settings in the menu sets light or dark on this device, and System follows the device", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signUp(page);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const surface = page.getByRole("main");
  const background = () => surface.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await theme()).toBe("light");
  await expect(page.locator(".shell-main")).toHaveCSS("background-color", "rgb(242, 245, 252)");

  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByText(/Signed in as nav-\d+@test\.local, Owner\./)).toBeVisible();
  await expect(page.getByRole("link", { name: "AI model" })).toHaveAttribute("href", "#/settings/ai");
  const light = await background();
  await page.getByLabel("Dark").check();
  expect(await theme()).toBe("dark");
  await expect.poll(background).not.toBe(light);
  await expect(surface).toHaveCSS("color-scheme", "dark");

  // The choice is kept on reload and set before the page draws (public/theme.js).
  await page.reload();
  expect(await theme()).toBe("dark");
  await expect(page.getByLabel("Dark")).toBeChecked();
  await expect.poll(background).not.toBe(light);

  // The Automations table follows the theme too: Dark gives the dark surface and dark panel colours.
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  expect(await theme()).toBe("dark");
  await expect(page.locator(".shell-main")).toHaveCSS("background-color", "rgb(11, 16, 32)");
  await expect(page.locator("main.ops")).toHaveCSS("background-color", "rgb(19, 26, 48)");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Dark")).toBeChecked();
  await expect.poll(background).not.toBe(light);

  // System follows the device again, including a later switch.
  await page.getByLabel("System (follows this device)").check();
  expect(await theme()).toBe("light");
  await expect.poll(background).toBe(light);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(theme).toBe("dark");
  await expect.poll(background).not.toBe(light);
});

test("Apps lists each app as a card, and Connect opens that app's own setup", async ({ page }) => {
  await signUp(page);
  await page.getByRole("link", { name: "Apps" }).first().click();
  await expect(page.getByRole("button", { name: "All 14" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Connected 0" })).toBeVisible();
  const more = page.getByRole("region", { name: "More" });
  for (const name of ["Gmail", "Outlook", "Google Sheets", "Slack", "Microsoft Teams", "Telegram", "UniSMS", "Facebook Messenger & Instagram", "Google Calendar", "Google Drive", "PayMongo", "Airtable", "Notion", "Trello"]) await expect(more.getByRole("heading", { name, exact: true })).toBeVisible();

  await page.getByLabel("Find an app").fill("sla");
  await expect(more.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Connect Slack" }).click();
  const slackSetup = page.getByRole("region", { name: "Slack setup" });
  await expect(slackSetup.getByRole("button", { name: "Connect Slack" })).toBeVisible();
  await slackSetup.getByText("Advanced: use your own Slack app token").click();
  await expect(slackSetup.getByLabel("Bot token")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close Slack" })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Connected 0" }).click();
  await expect(page.getByText("Nothing is connected yet.")).toBeVisible();
});

test("desktop rail pushes the page, supports keyboard dismissal and respects reduced motion", async ({ page }) => {
  await signUp(page);
  const rail = page.locator(".sidebar");
  const main = page.locator(".shell-main");
  await page.mouse.move(500, 600);
  await expect(rail).toHaveCSS("width", "64px");
  const left = () => main.evaluate(node => node.getBoundingClientRect().left);
  expect(await left()).toBe(64);
  await page.screenshot({ path: test.info().outputPath("desktop-collapsed.png") });
  // Advance the hover timer deterministically before allowing browser animations to run.
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.mouse.move(20, 130);
  await page.clock.runFor(149);
  await expect(rail).not.toHaveAttribute("data-expanded", "true");
  await page.mouse.move(500, 600);
  await page.clock.runFor(200);
  await expect(rail).not.toHaveAttribute("data-expanded", "true");
  await page.clock.resume();
  await rail.hover();
  await expect(rail).toHaveCSS("width", "232px");
  expect(await left()).toBe(232);
  await page.mouse.move(600, 600);
  await expect(rail).toHaveCSS("width", "64px");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const team = rail.getByRole("link", { name: "Team", exact: true });
  await rail.getByRole("link", { name: "Build with AI", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(team).toBeFocused();
  await expect(rail).toHaveCSS("width", "232px");
  await expect(rail).toHaveCSS("transition-duration", "0s");
  await page.keyboard.press("Escape");
  await expect(rail).toHaveCSS("width", "64px");
  await expect(team).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(team).toHaveAttribute("aria-current", "page");
  // hover() waits until the rail receives the pointer; a bare mouse.move can land while the new page renders.
  await rail.hover({ position: { x: 20, y: 90 } });
  await expect(rail).toHaveCSS("width", "232px");
  await page.screenshot({ path: test.info().outputPath("desktop-team.png") });
});

test("phone menu closes with Escape, Close and route changes, including Back", async ({ page }) => {
  await signUp(page);
  await page.setViewportSize({width: 390, height: 844});
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  const nav = page.locator("#main-menu");
  await menu.click();
  await expect(nav).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("phone-menu.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(menu).toBeFocused();
  await menu.click();
  await nav.getByRole("link", { name: "Team" }).click();
  await expect(menu).toHaveAttribute("aria-expanded","false");
  await menu.click();
  await page.goBack();
  await expect(nav).toBeHidden();
});

test("operator navigation and restricted landings stay scoped to their roles", async ({ page, browser }) => {
  await signUp(page);
  for (const role of ["operator", "requester", "approver"]) {
    const response = await page.request.post("/workspace/invites", { data: { email: `${role}-${Date.now()}@test.local`, role } });
    expect(response.ok()).toBe(true);
    const member = await browser.newPage();
    try {
      await member.goto((await response.json()).link);
      await member.getByLabel(/Password/).fill("e2e test password 1");
      await member.getByRole("button", { name: "Join" }).click();
      await expect(member.getByRole("heading", { name: role === "operator" ? "Automations" : "My requests", exact: true })).toBeVisible();
      await expect(member.getByRole("link", { name: "Build with AI", exact: true })).toHaveCount(0);
      if (role === "operator") {
        const rail = member.locator(".sidebar");
        await rail.hover();
        await rail.getByRole("link", { name: "Bookings", exact: true }).click();
        await expect(rail.getByRole("link", { name: "Bookings" })).toHaveAttribute("aria-current", "page");
        await rail.getByRole("link", { name: "Account", exact: true }).click();
        await expect(member).toHaveURL(/#\/account$/);
        await rail.getByRole("button", { name: "Sign out" }).click();
        await expect(member.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
      } else {
        await expect(member.locator(".sidebar")).toHaveCount(0);
      }
    } finally {
      await member.close();
    }
  }
});
