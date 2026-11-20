import { expect, test } from "@playwright/test";
import { joinAs, registerOwner } from "./workspace";

// W5: the owner reaches each tool from the directory and comes back; an operator who types #/advanced lands on
// Automations and sees none of it. The phone list keeps the same links.
test("Advanced lists the owner's tools and the automations, and hides them from an operator", async ({ page, browser }) => {
  await registerOwner(page);
  const stamp = Date.now();
  const wf = await (await page.request.post("/workflows", { data: { name: "Contact form", slug: `contact-${stamp}` } })).json();
  await page.goto("/#/advanced");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Advanced", level: 1 })).toBeVisible();
  const settings = page.getByRole("region", { name: "Settings" });
  for (const [name, href, note] of [
    ["AI model", "#/settings/ai", "which model drafts and classifies, and its key"],
    ["API tokens", "#/tokens", "for MCP clients and scripts"],
    ["Secrets", "#/secrets", "for webhook signing and HTTP step keys"],
    ["Resources", "#/resources", "rooms, people and tables that bookings reserve"],
  ]) {
    await expect(settings.getByRole("link", { name: name!, exact: true })).toHaveAttribute("href", href!);
    await expect(settings.getByText(note!)).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Contact form", exact: true })).toHaveAttribute("href", `#/w/${wf.id}`);
  await expect(page.getByRole("link", { name: "Versions of Contact form" })).toHaveAttribute("href", `#/w/${wf.id}/versions`);
  await expect(page.getByRole("link", { name: "New automation", exact: true }).last()).toHaveAttribute("href", "#/new");

  // The whole row opens its page, and a tool page links back to Advanced.
  await settings.getByText("Open").first().click({ force: true });
  await expect(page).toHaveURL(/#\/settings\/ai$/);
  await page.goto("/#/secrets");
  await page.getByRole("link", { name: "Advanced", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Advanced", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Menu", exact: true }).click();
  await expect(page).toHaveURL(/#\/settings$/);

  // Phone: the same four tools, one per row.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/advanced");
  await expect(page.getByRole("heading", { name: "Advanced", level: 1 })).toBeVisible();
  await expect(page.locator(".wk-dir-name a")).toHaveCount(4);

  await page.setViewportSize({ width: 1280, height: 720 });
  const operator = await joinAs(browser, page, "Operator", { width: 1280, height: 720 });
  await operator.goto("/#/advanced");
  await expect(operator.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();
  await expect(operator.getByRole("heading", { name: "Advanced", level: 1 })).toHaveCount(0);
  await operator.context().close();
});
