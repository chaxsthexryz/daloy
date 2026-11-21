import { expect, test, type Page } from "@playwright/test";

// R4: the phone step editor (390 px) and the canvas controls. Nothing an edit does saves or publishes by itself.
async function draftFlow(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`r4-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  const wf = await (await page.request.post("/workflows", { data: { name: "Phone editor", slug: `phone-${Date.now()}` } })).json();
  const definition = {
    trigger: { type: "manual", config: {} },
    steps: [
      { id: "post", type: "http", config: { method: "POST", url: "https://orders.example.com/orders", headers: {}, body: "{}" } },
      { id: "wait", type: "delay", config: { seconds: 60 } },
      { id: "mail", type: "email", config: { to: "ana@example.com", subject: "Hello", text: "Hi" } },
    ],
    edges: [
      { from: "post", to: "wait" },
      { from: "wait", to: "mail" },
    ],
  };
  const saved = await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: false } });
  expect(saved.ok()).toBe(true);
  return wf.id as string;
}
const versionOf = async (page: Page, id: string) => {
  const w = await (await page.request.get(`/workflows/${id}`)).json();
  return { latest: w.latest?.version, live: w.live };
};
const ids = (page: Page) => page.locator(".a7-list-id").allTextContents();

test("on a 390 px phone: add, move, edit and undo steps with 44 px targets, and nothing publishes by itself", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await draftFlow(page);
  await page.goto(`/#/w/${id}`);
  await expect(page.getByRole("heading", { name: "Phone editor", level: 1 })).toBeVisible();
  expect(await ids(page)).toEqual(["post", "wait", "mail"]);
  expect(await versionOf(page, id)).toEqual({ latest: 1, live: null });

  // Move with buttons, no dragging. The ends have nowhere to go.
  await expect(page.getByRole("button", { name: "Move post up" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move mail down" })).toBeDisabled();
  await page.getByRole("button", { name: "Move post down" }).click();
  expect(await ids(page)).toEqual(["wait", "post", "mail"]);
  await expect(page.locator(".a7-note").filter({ hasText: "Moved post to step 2." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move post down" })).toBeFocused();

  // Every control a seller taps is at least 44 px high and wide.
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".a7-move button, .a7-undo button, .a7-view button, .a7-list > li > button:first-child, .a7-add, .add-step button, .add-step select")]
      .map((el) => ({ name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName, box: el.getBoundingClientRect() }))
      .filter(({ box }) => box.height < 43.5 || box.width < 43.5)
      .map(({ name, box }) => `${name} ${Math.round(box.width)}x${Math.round(box.height)}`),
  );
  expect(small).toEqual([]);

  // Undo and redo restore the exact earlier order.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await ids(page)).toEqual(["post", "wait", "mail"]);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await ids(page)).toEqual(["wait", "post", "mail"]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();

  // Editing opens a sheet over the list; typing in it is one undo step.
  await page.getByRole("button", { name: /^wait / }).click();
  const sheet = page.getByRole("dialog", { name: "Edit step" });
  await expect(sheet).toBeVisible();
  const seconds = sheet.getByRole("spinbutton").first();
  await seconds.fill("90");
  await expect(seconds).toHaveValue("90");
  const done = sheet.getByRole("button", { name: "Done" });
  expect((await done.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await done.click();
  await expect(sheet).toBeHidden();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: /^wait / }).click();
  await expect(page.getByRole("dialog", { name: "Edit step" }).getByRole("spinbutton").first()).toHaveValue("60");
  await page.getByRole("dialog", { name: "Edit step" }).getByRole("button", { name: "Done" }).click();

  // Add from the same list, then undo the add.
  const before = await ids(page);
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Add a step after mail" });
  await menu.getByRole("searchbox", { name: "Search steps" }).fill("sheet");
  expect(await menu.getByRole("button").count()).toBeGreaterThan(0);
  expect((await menu.getByRole("button").first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await menu.getByRole("button").first().click();
  expect(await ids(page)).toEqual([...before, "sheets_1"]);
  await page.getByRole("dialog", { name: "Edit step" }).getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await ids(page)).toEqual(before);

  // From a step's own sheet, add right after it.
  await page.getByRole("button", { name: /^wait / }).click();
  await page.getByRole("button", { name: "Add a step after this one" }).click();
  await page.getByRole("dialog", { name: "Add a step after wait" }).getByRole("searchbox", { name: "Search steps" }).fill("delay");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Add a step after wait" })).toHaveCount(0);
  await page.getByRole("dialog", { name: "Edit step" }).getByRole("button", { name: "Done" }).click();
  expect(await ids(page)).toContain("delay_1");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await ids(page)).toEqual(before);

  // Publish still goes through the Turn on summary, and cancelling leaves everything as it was.
  await page.getByRole("button", { name: "Publish" }).click();
  const turnOn = page.getByRole("dialog", { name: "Turn on this automation" });
  await expect(turnOn).toBeVisible();
  await turnOn.getByRole("button", { name: "Cancel" }).click();
  expect(await versionOf(page, id)).toEqual({ latest: 1, live: null });
  await expect(page.locator(".a7-chip")).toHaveText("Draft");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("canvas controls: plus on a connection, searchable add menu, Shift+F10, Ctrl+Z and Connect to", async ({ page }) => {
  const id = await draftFlow(page);
  await page.goto(`/#/w/${id}`);
  await expect(page.getByRole("heading", { name: "Phone editor", level: 1 })).toBeVisible();
  const node = (step: string) => page.locator(`.react-flow__node[data-id="${step}"]`);
  await expect(node("wait")).toBeVisible();

  // The plus on a connection opens the add menu there; Enter adds the first match and wires it between the two steps.
  await page.getByRole("button", { name: "Add a step between post and wait" }).click();
  const menu = page.getByRole("dialog", { name: "Add a step after post" });
  await menu.getByRole("searchbox", { name: "Search steps" }).fill("delay");
  await page.keyboard.press("Enter");
  await expect(node("delay_1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a step between delay_1 and wait" })).toBeVisible();

  // Ctrl+Z takes it back and Ctrl+Shift+Z puts it back; neither saves anything.
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect(node("delay_1")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect(node("delay_1")).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(node("delay_1")).toHaveCount(0);

  // Shift+F10 on a focused step opens the same menu for it, and Escape closes it.
  await node("wait").focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("dialog", { name: "Add a step after wait" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Connect to refuses a loop and says why; the draft stays as it was.
  await node("wait").click();
  await page.getByLabel("Go to", { exact: true }).selectOption("post");
  await expect(page.getByRole("alert").filter({ hasText: "post already leads to wait, so this would make a loop." })).toBeVisible();
  await expect(page.getByLabel("Go to", { exact: true })).toHaveValue("mail");
  expect(await versionOf(page, id)).toEqual({ latest: 1, live: null });
});
