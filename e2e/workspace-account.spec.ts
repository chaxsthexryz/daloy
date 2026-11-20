import { expect, test } from "@playwright/test";
import { PASSWORD, joinAs, registerOwner } from "./workspace";

// W4: the page checks the form first, shows the API's refusal beside the right field and clears the form on success.
test("Account checks the passwords, names a wrong current password and confirms the change", async ({ page }) => {
  await registerOwner(page);
  await page.goto("/#/account");
  const current = page.getByLabel("Current password");
  const next = page.getByLabel(/New password/);
  let sent = 0;
  page.on("request", (r) => r.url().endsWith("/auth/password") && sent++);

  await next.fill("a brand new password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter your current password.");
  await expect(current).toHaveAttribute("aria-invalid", "true");

  await current.fill(PASSWORD);
  await next.fill("too short");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("alert")).toHaveText("The new password needs at least 12 characters.");
  await expect(next).toHaveAttribute("aria-invalid", "true");
  expect(sent).toBe(0);

  await current.fill("not the password");
  await next.fill("a brand new password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("alert")).toHaveText("current password is wrong");
  await expect(current).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("status")).toBeHidden();

  await current.fill(PASSWORD);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("status")).toHaveText("Password changed. Your other sessions are signed out.");
  await expect(current).toHaveValue("");
  await expect(next).toHaveValue("");
  expect(sent).toBe(2);
});

// W4 phone: a requester has no rail, so the page links back to My requests.
test("a requester reaches Account from My requests and returns with the back link", async ({ page, browser }) => {
  await registerOwner(page);
  const requester = await joinAs(browser, page, "Requester", { width: 390, height: 844 });
  await expect(requester.getByRole("heading", { name: "My requests" })).toBeVisible();
  await requester.getByRole("link", { name: "Account" }).click();
  await expect(requester).toHaveURL(/#\/account$/);
  await expect(requester.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await requester.getByRole("link", { name: "My requests" }).click();
  await expect(requester.getByRole("heading", { name: "My requests" })).toBeVisible();
  await requester.context().close();
});
