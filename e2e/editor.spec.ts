import { captureReview } from "./review-capture";
import { expect, test, type Page } from "@playwright/test";
import { addStep } from "./editor-steps";

// A7: the Steps editor on a disposable workflow. Trigger, branches, the list view, app setup, a mocked test run, save and publish.
test("edit trigger, steps and branches, then test, save and publish", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`a7-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto("/#/new");
  await page.getByLabel("Name").fill("Receipt approvals");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Receipt approvals", level: 1 })).toBeVisible();
  await expect(page.locator(".a7-chip")).toHaveText("Draft");

  // The list view is the keyboard and screen reader route to every step.
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("button", { name: "Trigger: You run it" }).click();
  await page.getByLabel("Starts when").selectOption("form");
  await expect(page.getByRole("group", { name: "Form fields" })).toBeVisible();

  // An approval with a step on two of its branches, added from the list's "+ Add a step at the end" and the step's own panel.
  await addStep(page, "approval");
  await expect(page.getByText("Step 1 · Approval")).toBeVisible();
  await addStep(page, "email", { after: "approval_1", branch: "rejected" });
  await page.getByRole("button", { name: /^approval_1 / }).click();
  await addStep(page, "sheets", { after: "approval_1", branch: "approved" });

  // The sheet needs Google Sheets, which this new workspace has not connected.
  await expect(page.getByText("0 of 1 apps connected")).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect Google Sheet" })).toHaveAttribute("href", "#/apps");
  await expect(page.getByRole("button", { name: /^sheets_1 .*approval_1 on approved/ })).toBeVisible();

  await page.getByRole("button", { name: /^approval_1 / }).click();
  const next = page.getByRole("region", { name: "What happens next" });
  await expect(next).toContainText("approvedsheets_1");
  await expect(next).toContainText("rejectedemail_1");

  // With no text field chosen yet, a reference to earlier data copies to the clipboard (E3).
  await page.getByRole("button", { name: /^email_1 / }).click();
  await page.getByRole("button", { name: "Insert {{trigger.email}}" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied {{trigger.email}}");

  // The diagram draws every step; the zoom bar changes the zoom.
  await page.getByRole("button", { name: "Diagram", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(page.locator(".a7-needs-app")).toContainText("Connect Google Sheets");
  // Each node says the app, the action and where it acts (roadmap R2a).
  const sheetNode = page.locator(".a7-node", { hasText: "Add a row" });
  await expect(sheetNode).toContainText("Google Sheets");
  await expect(sheetNode).toContainText("Sheet: chosen in Apps");
  await expect(sheetNode.getByRole("img", { name: "Google Sheets" })).toBeHidden();
  await expect(page.locator(".a7-node", { hasText: "Send email" })).toContainText("To: Email from the form");
  await captureReview(page, "05", "Workflow steps", "The canvas shows the app, action and destination for each step.");
  const level = page.locator(".a7-zoom-level");
  const before = await level.textContent();
  await page.getByRole("button", { name: "Zoom Out" }).click();
  await expect(level).not.toHaveText(before!);

  // The panel's Test run runs the draft with mocked calls.
  await page.getByRole("button", { name: "Test run", exact: true }).click();
  await expect(page.locator(".run > p").first()).toHaveText(/test run, mocked calls/, { timeout: 30_000 });
  await expect(page.locator(".run")).toContainText("approval_1 → approved");

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").first()).toHaveText(/Saved as version \d+\./);

  // Publishing needs every app connected, so drop the sheet first.
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("button", { name: /^sheets_1 / }).click();
  await page.getByRole("button", { name: "Delete step" }).click();
  await expect(page.getByText("0 of 1 apps connected")).toBeHidden();
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.getByRole("status").first()).toHaveText(/Version \d+ is live\./);
  await expect(page.locator(".a7-chip")).toHaveText("Live");
});

// U2: a condition and an approval drawn on the canvas, each branch with its own plus.
async function branchedFlow(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`u2-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  const wf = await (await page.request.post("/workflows", { data: { name: "Branches", slug: `branches-${Date.now()}` } })).json();
  const mail = (to: string) => ({ to, subject: "Hello", text: "Hi" });
  const definition = {
    trigger: { type: "manual", config: {} },
    steps: [
      { id: "check", type: "condition", config: { condition: { left: "{{trigger.amount}}", op: "gt", right: 100 } } },
      { id: "ask", type: "approval", config: { to: "boss@example.com", subject: "Approve?", message: "Please approve", timeoutSeconds: 3600 } },
      { id: "no_mail", type: "email", config: mail("no@example.com") },
      { id: "ok_mail", type: "email", config: mail("ok@example.com") },
      { id: "bad_mail", type: "email", config: mail("bad@example.com") },
      { id: "late_mail", type: "email", config: mail("late@example.com") },
    ],
    edges: [
      { from: "check", to: "ask", on: "true" },
      { from: "check", to: "no_mail", on: "false" },
      { from: "ask", to: "ok_mail", on: "approved" },
      { from: "ask", to: "bad_mail", on: "rejected" },
      { from: "ask", to: "late_mail", on: "timeout" },
    ],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: false } })).ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/#/w/${wf.id}`);
  await expect(page.getByRole("heading", { name: "Branches", level: 1 })).toBeVisible();
  return wf.id as string;
}

test("the plus on each branch of a condition and an approval adds the step on that branch", async ({ page }) => {
  await branchedFlow(page);
  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(node("late_mail")).toBeVisible();

  // No plus sits on a branch pill or on another plus.
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".a7-insert, .a7-editor .react-flow .a7-branch")].map((el) => ({ name: el.getAttribute("aria-label") ?? el.textContent, ...el.getBoundingClientRect().toJSON() })),
  );
  const overlaps = boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).map((b) => `${a.name} / ${b.name}`));
  expect(overlaps).toEqual([]);

  const cases = [
    ["check", "ask", "true"],
    ["check", "no_mail", "false"],
    ["ask", "ok_mail", "approved"],
    ["ask", "bad_mail", "rejected"],
    ["ask", "late_mail", "timeout"],
  ] as const;
  for (const [n, [from, to, branch]] of cases.entries()) {
    await page.getByRole("button", { name: `Add a step between ${from} and ${to}` }).click();
    const menu = page.getByRole("dialog", { name: `Add a step after ${from}` });
    // The list wraps its descriptions: nothing scrolls sideways and the first row is in view.
    const list = menu.locator(".a7-menu-list");
    expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(list.getByRole("button").first()).toBeInViewport({ ratio: 1 });
    await menu.getByRole("searchbox", { name: "Search steps" }).fill("delay");
    await page.keyboard.press("Enter");
    const added = `delay_${n + 1}`;
    await expect(node(from)).toHaveAttribute("aria-label", new RegExp(`on ${branch} goes to ${added}(,|$)`));
    await expect(node(added)).toHaveAttribute("aria-label", new RegExp(`goes to ${to}$`));
  }
});

test("the panel: actions stay pinned in the header, AI box with nothing selected, close, Escape, and folding kept per viewer", async ({ page }) => {
  await branchedFlow(page);
  const panel = page.locator(".a7-panel");
  const headActions = page.locator(".a7-head").getByRole("group", { name: "Workflow actions" });
  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(headActions.getByRole("button")).toHaveText(["Test run", "Explain", "Save", "Publish"]);
  await expect(panel.getByRole("group", { name: "Workflow actions" })).toHaveCount(0);
  await expect(panel.getByRole("region", { name: "Ask the AI" })).toBeVisible();
  await expect(panel.locator("summary", { hasText: "Test settings" })).toBeVisible();
  await expect(page.locator("#add-step-type")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add a step at the end" })).toHaveCount(0);

  // A selected step shows its dots; other steps keep theirs hidden.
  await node("ok_mail").click();
  await expect(panel.getByRole("heading", { name: "ok_mail" })).toBeVisible();
  await expect(node("ok_mail").locator(".react-flow__handle").first()).toBeVisible();
  await expect(node("bad_mail").locator(".react-flow__handle").first()).toBeHidden();
  await expect(headActions).toBeVisible();
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Ask the AI" })).toBeVisible();
  await node("ok_mail").click();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("heading", { name: "ok_mail" })).toHaveCount(0);

  // Double click opens the step and focuses its first field.
  await node("ok_mail").dblclick();
  await expect(panel.locator(".a7-inspector :is(input, select, textarea)").first()).toBeFocused();
  await panel.getByRole("button", { name: "Close", exact: true }).click();

  // Folded, the panel is a strip and the four actions stay pinned in the header. The choice survives a reload; selecting a step opens it.
  await page.getByRole("button", { name: "Hide the side panel" }).click();
  await expect(panel).toHaveCount(0);
  await expect(headActions.getByRole("button", { name: "Publish" })).toBeVisible();
  expect(Math.round((await page.locator(".a7-side").boundingBox())!.width)).toBe(44);
  await page.reload();
  await expect(page.getByRole("button", { name: "Show the side panel" })).toHaveAttribute("aria-expanded", "false");
  await node("check").click();
  await expect(panel.getByRole("heading", { name: "check" })).toBeVisible();
  await expect(headActions.getByRole("button", { name: "Publish" })).toBeVisible();
  await page.getByRole("button", { name: "Hide the side panel" }).click();
  await page.getByRole("button", { name: "Show the side panel" }).click();
  await expect(panel).toBeVisible();
});

test("drag from a connection dot: onto empty canvas adds a step there, onto a step connects or says why not", async ({ page }) => {
  await branchedFlow(page);
  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const note = page.locator(".a7-note");
  const drag = async (from: string, handle: string, to: { x: number; y: number }) => {
    await node(from).click();
    const box = (await node(from).locator(handle).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await expect(page.locator(".a7-drop rect")).toBeVisible();
    await page.mouse.up();
  };
  const centre = async (id: string) => {
    const b = (await node(id).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  // Empty canvas under ok_mail: the add menu opens there and the step lands after ok_mail.
  const below = (await node("ok_mail").boundingBox())!;
  await drag("ok_mail", ".react-flow__handle-bottom", { x: below.x + below.width / 2, y: below.y + below.height + 80 });
  const menu = page.getByRole("dialog", { name: "Add a step after ok_mail" });
  await menu.locator('[data-type="delay"]').click();
  await expect(node("ok_mail")).toHaveAttribute("aria-label", /goes to delay_1$/);

  // Onto another step: no_mail now also leads to late_mail.
  await drag("no_mail", ".react-flow__handle-bottom", await centre("late_mail"));
  await expect(note).toHaveText("Connected no_mail to late_mail.");
  await expect(node("no_mail")).toHaveAttribute("aria-label", /goes to late_mail$/);

  // A loop is refused with the reason, and nothing changes.
  await drag("ask", '.react-flow__handle[data-handleid="approved"]', await centre("check"));
  await expect(note).toHaveText("check already leads to ask, so this would make a loop.");
  await expect(node("ask")).toHaveAttribute("aria-label", /on approved goes to ok_mail/);
});

test("right-click menus: duplicate, copy and paste, connect to and test this step", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await branchedFlow(page);
  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const note = page.locator(".a7-note");
  const pick = async (id: string, item: string) => {
    await node(id).click({ button: "right" });
    await page.getByRole("menu", { name: `Actions for ${id}` }).getByRole("menuitem", { name: item }).click();
  };

  await node("bad_mail").click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Actions for bad_mail" }).getByRole("menuitem")).toHaveText([
    "Test this step",
    "Add a step after this one",
    "DuplicateCtrl+D",
    "CopyCtrl+C",
    "Connect to",
    "Disable",
    "DeleteDel",
  ]);
  await page.keyboard.press("Escape");

  // Duplicate puts the copy right after the original; a branching step says why it cannot be copied.
  await pick("bad_mail", "Duplicate");
  await expect(node("bad_mail")).toHaveAttribute("aria-label", /goes to bad_mail_copy$/);
  await pick("check", "Duplicate");
  await expect(note).toHaveText("check has branches, so it cannot be duplicated. Add a step and copy its settings instead.");
  await node("late_mail").click();
  await page.keyboard.press("Control+d");
  await expect(node("late_mail_copy")).toBeVisible();

  // Copy, then paste from the canvas menu: the pasted step goes after the selected one.
  await pick("no_mail", "Copy");
  await expect(note).toHaveText("Copied no_mail. Paste with Ctrl+V.");
  const pane = (await page.locator(".a7-flow").boundingBox())!;
  await page.mouse.click(pane.x + pane.width - 40, pane.y + 60, { button: "right" });
  await page.getByRole("menu", { name: "Canvas actions" }).getByRole("menuitem", { name: /^Paste step/ }).click();
  await expect(note).toHaveText("Pasted email_1.");
  await expect(node("no_mail")).toHaveAttribute("aria-label", /goes to email_1$/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(node("email_1")).toHaveCount(0);

  // Connect to: the next step clicked becomes where this one leads.
  await pick("late_mail_copy", "Connect to");
  await expect(note).toHaveText("Click the step late_mail_copy goes to. Escape cancels.");
  await node("ok_mail").click();
  await expect(note).toHaveText("Connected late_mail_copy to ok_mail.");

  // Test this step runs the mocked test and shows that step's line.
  await pick("check", "Test this step");
  await expect(page.locator(".a7-test .steps")).toContainText("check", { timeout: 30_000 });

  // The step's own panel tests it and shows its last attempt there, without leaving the step (decision 0110).
  await node("check").click();
  const own = page.getByRole("region", { name: "Test this step" });
  await expect(own.getByRole("button", { name: "Try this step for real" })).toHaveCount(0);
  await own.getByRole("button", { name: "Test this step" }).click();
  await expect(own.locator(".a7-last-test .run")).toContainText("check", { timeout: 30_000 });
  await node("ok_mail").click();
  await expect(page.getByRole("region", { name: "Test this step" }).getByRole("button", { name: "Try this step for real" })).toBeVisible();
});

// E1: visible add stubs below leaves and open branch exits append steps directly without dragging handles.
test("visible leaf and empty-branch add controls append steps and never overlap branch pills", async ({ page }) => {
  await branchedFlow(page);
  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(node("ok_mail")).toBeVisible();

  // E2 branch-aware DAG places the false leaf (no_mail) strictly right of ask's widest branch (late_mail).
  const [noBox, lateBox] = [(await node("no_mail").boundingBox())!, (await node("late_mail").boundingBox())!];
  expect(noBox.x).toBeGreaterThan(lateBox.x);

  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".a7-insert, .a7-leaf-add, .a7-branch-add, .a7-editor .react-flow .a7-branch")].map((el) => ({
      name: el.getAttribute("aria-label") ?? el.textContent,
      ...el.getBoundingClientRect().toJSON(),
    })),
  );
  const overlaps = boxes.flatMap((a, i) =>
    boxes.slice(i + 1).filter((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).map((b) => `${a.name} / ${b.name}`),
  );
  expect(overlaps).toEqual([]);

  await page.getByRole("button", { name: "Add a step after ok_mail" }).click();
  const addAfterOk = page.getByRole("dialog", { name: "Add a step after ok_mail" });
  await addAfterOk.getByRole("searchbox", { name: "Search steps" }).fill("condition");
  await page.keyboard.press("Enter");
  await expect(node("ok_mail")).toHaveAttribute("aria-label", /goes to condition_1$/);
  await expect(page.getByRole("button", { name: "Add a step on true after condition_1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a step on false after condition_1" })).toBeVisible();

  await page.getByRole("button", { name: "Add a step on false after condition_1" }).click();
  const addFalse = page.getByRole("dialog", { name: "Add a step after condition_1" });
  await addFalse.getByRole("searchbox", { name: "Search steps" }).fill("delay");
  await page.keyboard.press("Enter");
  await expect(node("condition_1")).toHaveAttribute("aria-label", /on false goes to delay_1$/);
  await expect(page.getByRole("button", { name: "Add a step on true after condition_1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a step on false after condition_1" })).toHaveCount(0);
});
