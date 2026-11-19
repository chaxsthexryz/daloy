import { expect } from "@playwright/test";
import { formPath, reference, runId, samplePassword, workflowId, officeId, purchaseId, inviteToken, resetToken } from "./fixtures.mjs";

const heading = (page, name) => page.getByRole("heading", { name, exact: true });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const visible = (locator) => expect(locator.first()).toBeVisible();
const hasText = (name) => (page) => visible(page.getByText(name, { exact: true }));
const hasHeading = (name) => (page) => visible(heading(page, name));
const hasButton = (name) => (page) => visible(button(page, name));

export const screens = [
  { name: "Automations", path: "", title: ["Automations", "Mga automation"], note: "Review status, choose a work queue, or open a workflow.", verify: hasText("Office intake") },
  { name: "Activity", path: "activity", title: ["Activity", "Aktibidad"], note: "Find runs by request reference or automation.", verify: hasText(reference) },
  { name: "Run details", path: `runs/${runId}`, title: ["What happened", "Ano ang nangyari"], note: "See which step failed and inspect the path the run took.", verify: (page) => visible(page.locator(".operations-run-status")) },
  {
    name: "Ask about a request", path: `runs/${runId}/ask`, title: ["Ask what happened", "Itanong kung ano ang nangyari"],
    note: "Ask why the sample request stopped and see the suggested next step.",
    async verify(page, language) {
      await button(page, language === "tl" ? "Bakit ito huminto?" : "Why did it stop?").click();
      await visible(page.getByText("Sample office inbox refused a message.", { exact: true }));
    },
  },
  { name: "Bookings", path: "bookings", title: ["Bookings", "Mga booking"], note: "Review appointments, reschedule, or record a no-show.", verify: hasText("BK-SAMPLE") },
  { name: "Resources", path: "resources", title: ["Resources"], note: "Manage the people and rooms available for bookings.", verify: hasText("Reception") },
  { name: "New automation", path: "new", title: ["New automation", "Bagong automation"], note: "Start with a guided setup, an existing template or a custom workflow.", verify: (page, language) => hasHeading(language === "tl" ? "Mag-set up sa ilang tanong" : "Set up with a few questions")(page) },
  {
    name: "Build with AI", path: "ai", title: ["Build with AI"], note: "Review a draft returned by the sample AI response.",
    async verify(page) {
      await page.getByLabel("What should happen?", { exact: true }).fill("Send an email when the office submits a request.");
      await button(page, "Send").click();
      await visible(heading(page, "Check the draft: Office intake"));
    },
  },
  { name: "Workflow editor", path: `w/${workflowId}`, title: ["Office intake"], note: "Inspect workflow steps before testing or publishing.", verify: hasHeading("Steps") },
  { name: "Version history", path: `w/${workflowId}/versions`, title: ["Versions"], note: "Review the published workflow version and its diff.", verify: hasHeading("Version 1") },
  { name: "Apps", path: "apps", title: ["Apps"], note: "Find a provider and open its connection settings.", verify: hasHeading("Slack") },
  { name: "Settings", path: "settings", title: ["Settings", "Settings"], note: "Review workspace language, appearance and usage.", verify: (page, language) => hasText(language === "tl" ? "Walang limit na nakatakda. Ang operator ang nagtatakda ng plan." : "No plan limits are set. The operator sets the plan.")(page) },
  { name: "AI model", path: "settings/ai", title: ["AI model"], note: "Review the model used for drafting and AI steps.", verify: (page) => visible(page.getByText("Sample model", { exact: true })) },
  { name: "Team", path: "team", title: ["Team"], note: "Check team roles and find the invitation form.", verify: hasText("approver@example.test") },
  { name: "Business", path: "settings/business", title: ["Business"], note: "Review the details used by customer-facing forms.", verify: hasHeading("Your business") },
  { name: "Advanced", path: "advanced", title: ["Advanced"], note: "Find developer settings and the workflow editor.", verify: (page) => visible(page.getByRole("main").getByRole("link", { name: "Secrets", exact: true })) },
  { name: "Secrets", path: "secrets", title: ["Secrets"], note: "See the example secret name and where to replace a value.", verify: hasText("OFFICE_KEY") },
  { name: "API tokens", path: "tokens", title: ["API tokens"], note: "Review the sample client's token scopes and expiry.", verify: hasText("Office client") },
  { name: "Account", path: "account", title: ["Account"], note: "Find the password change form.", verify: hasHeading("Change password") },
  {
    name: "Operator homepage", path: "team", title: ["Automations"], role: "operator",
    note: "An operator opening the Team URL sees their own Automations page, with work links in the menu.",
    async verify(page) {
      await visible(page.getByText("Office intake", { exact: true }).first());
      await expect(page.locator('#main-menu a[href="#/team"]')).toHaveCount(0);
      await expect(page.locator('#main-menu a[href="#/bookings"]')).toHaveCount(1);
    },
  },
  {
    name: "Office request example", path: "try/office-request", title: ["Preview only", "Preview lamang"],
    note: "Submit sample details and inspect the sample office alert and receipt.",
    async verify(page, language) {
      const tagalog = language === "tl";
      await button(page, tagalog ? "Subukan gamit ang halimbawang detalye" : "Try with sample details").click();
      await visible(heading(page, tagalog ? "Ano ang mangyayari (preview lamang)" : "What would happen (preview only)"));
    },
  },
  { name: "Office request setup", path: `a/${officeId}`, title: ["Set up: Track an office request", "I-set up: Subaybayan ang office request"], note: "Choose which extra details staff can add to the form.", verify: (page, language) => visible(page.getByRole("checkbox", { name: language === "tl" ? "Saan ito?" : "Where is it?" })) },
  { name: "Purchase request setup", path: `a/${purchaseId}`, title: ["Set up: Purchase request with a named approver"], note: "Choose the person who decides purchase requests.", verify: hasHeading("Who decides") },
  {
    name: "Hosted office form", url: formPath, title: ["Sample office", "Sample office"], role: "requester",
    note: "See the fields an employee fills in. The hosted form uses Daloy's form renderer and the sample submission returns a simulated receipt.",
    verify: (page, language) => visible(page.getByRole("textbox", { name: language === "tl" ? "Ano ang kailangang asikasuhin?" : "What needs attention?" })),
  },
  {
    name: "Requester view", path: "", title: ["My requests", "Mga request ko"], role: "requester",
    note: "Track the sample request using its reference.",
    async verify(page) {
      await visible(page.getByRole("cell", { name: new RegExp(`${reference}$`) }));
      await expect(page.locator("#main-menu")).toHaveCount(0);
    },
  },
  {
    name: "Approver view", path: "", title: ["My requests", "Mga request ko"], role: "approver",
    note: "See how the approver is told to open a named approval link from their email.",
    async verify(page) {
      await visible(page.getByText(/(?:Open the link while signed in|approver@example\.test.*para sumagot)/));
      await expect(page.locator("#main-menu")).toHaveCount(0);
    },
  },
  { name: "Sign in", path: "", title: ["Sign in"], role: "signed-out", note: "Open sign-in, account creation and password recovery.", verify: hasButton("Sign in") },
  { name: "Invitation", path: `invite/${inviteToken}`, title: ["Join your team"], role: "signed-out", note: "See the screen opened by a team invitation.", verify: hasButton("Join") },
  { name: "Forgot password", path: "forgot-password", title: ["Forgot your password?"], role: "signed-out", note: "Request a password recovery link.", verify: hasButton("Send link") },
  {
    name: "Reset password", path: `reset-password/${resetToken}`, title: ["Set a new password"], role: "signed-out", note: "Use the sample link to set a new password.",
    async verify(page) {
      await page.getByLabel(/^New password/).fill(samplePassword);
      await button(page, "Change password").click();
      await expect(page.getByRole("status")).toContainText("Password changed.");
    },
  },
  { name: "Empty workspace", path: "", title: ["Automations", "Mga automation"], state: "empty", note: "See the starting state before any automation exists.", verify: (page, language) => visible(page.getByText(language === "tl" ? /^Wala pang automation\./ : /^No automations yet\./)) },
  { name: "Workspace load error", path: "", title: ["Automations", "Mga automation"], state: "error", note: "See the error and Retry control when the workflow list fails to load.", verify: (page, language) => visible(page.getByRole("alert").getByRole("button", { name: language === "tl" ? "Subukan ulit" : "Retry" })) },
];

export async function checkNavigationAndActions(page, open) {
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 883 });
    await open({ path: "" });
    await visible(heading(page, "Automations"));
    const menu = page.locator("#main-menu");
    const navigation = width === 390 ? ".bottom-bar" : "#main-menu";
    const current = page.locator(`${navigation} a[href="#/"][aria-current="page"]`);
    await visible(current);
    if (width === 390) {
      const opener = button(page, "Menu");
      await opener.focus();
      await page.keyboard.press("Enter");
      await expect(menu.getByRole("link").first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(opener).toHaveAttribute("aria-expanded", "false");
      await expect(opener).toBeFocused();
    }
  }

  await open({ path: "bookings" });
  page.once("dialog", (dialog) => dialog.accept());
  await button(page, "Mark no-show").click();
  await visible(button(page, "Undo no-show"));

  await open({ path: "resources" });
  await button(page, "Archive").click();
  await visible(button(page, "Restore"));

  await open({ url: formPath, role: "requester" });
  await page.getByLabel("Your name").fill("Sample employee");
  await page.getByLabel("Your email").fill("requester@example.test");
  await page.getByLabel("What needs attention?").fill("The reception printer is jammed.");
  await button(page, "Send").click();
  await visible(heading(page, "Request received"));
  await visible(page.getByText(reference, { exact: true }));
}
