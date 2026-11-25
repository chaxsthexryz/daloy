import { expect, test, type Page } from "@playwright/test";

async function signUp(page: Page, prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  return email;
}

async function contrastRatio(page: Page, fgRgb: string, bgRgb: string): Promise<number> {
  return page.evaluate(
    ([fg, bg]) => {
      const parse = (s: string): [number, number, number] => {
        const m = s.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
        if (!m) throw new Error(`Cannot parse color: ${s}`);
        return [Number(m[1]), Number(m[2]), Number(m[3])];
      };
      const lum = ([r, g, b]: [number, number, number]) => {
        const lin = [r, g, b].map((c) => {
          const v = c / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
      };
      const [hi, lo] = [lum(parse(fg)), lum(parse(bg))].sort((a, b) => b - a);
      return (hi! + 0.05) / (lo! + 0.05);
    },
    [fgRgb, bgRgb] as const,
  );
}

test("summary card zero states stay green in Light, Dark and Taglish, and Dark mode contrast passes WCAG AA", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signUp(page, "f5-dark");

  // Create one healthy draft so the summary cards render on #/.
  const wf = await (await page.request.post("/workflows", { data: { name: "Healthy flow", slug: `healthy-${Date.now()}` } })).json();
  expect(wf.id).toBeTruthy();
  await page.reload();

  const needsVal = page.locator(".ops-kpi-cell.needs .ops-kval strong");
  const probVal = page.locator(".ops-kpi-cell.problems .ops-kval strong");
  await expect(needsVal).toHaveClass(/ok/);
  await expect(probVal).toHaveClass(/ok/);
  await expect(needsVal).toHaveCSS("color", "rgb(21, 128, 61)");
  await expect(probVal).toHaveCSS("color", "rgb(21, 128, 61)");

  // Switch to Dark mode via Settings and check summary card zero states.
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Dark").check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await expect(needsVal).toHaveClass(/ok/);
  await expect(probVal).toHaveClass(/ok/);
  await expect(needsVal).toHaveCSS("color", "rgb(110, 231, 183)");
  await expect(probVal).toHaveCSS("color", "rgb(110, 231, 183)");

  // Dark mode #/apps: softened logo tiles and WCAG AA disabled buttons on PayMongo.
  await page.getByRole("link", { name: "Apps", exact: true }).click();
  const logoTile = page.locator('.app-mark[data-kind="logo"]').first();
  await expect(logoTile).toBeVisible();
  const tileBg = await logoTile.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(tileBg).not.toBe("rgb(255, 255, 255)");

  await page.getByRole("button", { name: "Connect PayMongo" }).click();
  const saveKeyBtn = page.getByRole("button", { name: "Save key", exact: true });
  await expect(saveKeyBtn).toBeDisabled();
  const paymongoColors = await saveKeyBtn.evaluate((el) => {
    const s = getComputedStyle(el);
    return { fg: s.color, bg: s.backgroundColor, opacity: s.opacity };
  });
  expect(paymongoColors.opacity).toBe("1");
  expect(await contrastRatio(page, paymongoColors.fg, paymongoColors.bg)).toBeGreaterThanOrEqual(4.5);

  // Dark mode #/knowledge: disabled Publish button meets WCAG AA.
  await page.getByRole("link", { name: "Knowledge", exact: true }).click();
  const publishBtn = page.getByRole("button", { name: "Publish", exact: true });
  await expect(publishBtn).toBeDisabled();
  const knColors = await publishBtn.evaluate((el) => {
    const s = getComputedStyle(el);
    return { fg: s.color, bg: s.backgroundColor, opacity: s.opacity };
  });
  expect(knColors.opacity).toBe("1");
  expect(await contrastRatio(page, knColors.fg, knColors.bg)).toBeGreaterThanOrEqual(4.5);

  // Dark mode Editor connection progress track meets >= 3:1 contrast.
  const appFlow = await (await page.request.post("/workflows", { data: { name: "Needs PayMongo", slug: `pm-${Date.now()}` } })).json();
  const pmDef = {
    trigger: { type: "manual", config: {} },
    steps: [{ id: "pay", type: "paymongo_link", config: { amount: "500.00", description: "Deposit", reference: "BK-1" } }],
    edges: [],
  };
  await page.request.post(`/workflows/${appFlow.id}/versions`, { data: { definition: pmDef, publish: false } });
  await page.goto(`/#/w/${appFlow.id}`);
  const trackSegment = page.locator(".a7-setup-bars span").first();
  await expect(trackSegment).toBeVisible();
  const barColors = await page.locator(".a7-setup").evaluate((banner) => {
    const seg = banner.querySelector(".a7-setup-bars span")!;
    return {
      fg: getComputedStyle(seg).backgroundColor,
      bg: getComputedStyle(banner).backgroundColor,
    };
  });
  expect(await contrastRatio(page, barColors.fg, barColors.bg)).toBeGreaterThanOrEqual(3);

  // Switch to Taglish and verify "0 maayos lahat" stays green and sidebar labels are localized.
  await page.goto("/#/settings");
  await page.getByRole("radio", { name: "Taglish" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "tl");

  const rail = page.locator("#main-menu");
  await expect(rail.getByRole("link", { name: "Aklatan", exact: true })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Koponan", exact: true })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Mga setting", exact: true })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Account ko", exact: true })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Library", exact: true })).toHaveCount(0);
  await expect(rail.getByRole("link", { name: "Team", exact: true })).toHaveCount(0);
  await expect(rail.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(rail.getByRole("link", { name: "Account", exact: true })).toHaveCount(0);

  await rail.getByRole("link", { name: "Mga automation", exact: true }).click();
  await expect(page.locator(".ops-kpi-cell.problems")).toContainText("maayos lahat");
  await expect(probVal).toHaveCSS("color", "rgb(110, 231, 183)");

  await rail.getByRole("link", { name: "Mga app", exact: true }).click();
  await page.getByRole("button", { name: /PayMongo/ }).click();
  await expect(page.getByRole("button", { name: "Bumalik sa Mga app", exact: true })).toBeVisible();
});

test("overlays, landmarks and editor 50% Fit zoom keep content visible and unobstructed", async ({ page }) => {
  const email = await signUp(page, "f5-layout");

  // #/ai initial state has a visible <h1>, opaque Conversation logs drawer and visible delete button.
  await page.goto("/#/ai");
  const aiH1 = page.getByRole("heading", { name: "Build with AI", level: 1 });
  await expect(aiH1).toBeVisible();
  const h1Box = (await aiH1.boundingBox())!;
  expect(h1Box.width).toBeGreaterThan(20);
  expect(h1Box.height).toBeGreaterThan(15);

  await page.evaluate((userEmail) => {
    const key = `kymavo.ai.logs.${userEmail.trim().toLowerCase()}`;
    localStorage.setItem(
      key,
      JSON.stringify([
        {
          id: "log-1",
          title: "Resort inquiry reply",
          updatedAt: new Date().toISOString(),
          status: "draft",
          turns: [{ role: "user", text: "Reply to resort inquiries" }],
          draft: null,
        },
      ]),
    );
  }, email);
  await page.reload();

  await page.getByRole("button", { name: /Conversation logs/ }).click();
  const drawer = page.locator("#ai-logs-drawer");
  await expect(drawer).toBeVisible();
  const drawerStyle = await drawer.evaluate((el) => {
    const s = getComputedStyle(el);
    const layer = el.parentElement!;
    return { opacity: s.opacity, bg: s.backgroundColor, zIndex: Number(getComputedStyle(layer).zIndex) };
  });
  expect(drawerStyle.opacity).toBe("1");
  expect(drawerStyle.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(drawerStyle.zIndex).toBeGreaterThan(30);

  const deleteBtn = drawer.getByRole("button", { name: "Delete conversation" });
  await expect(deleteBtn).toBeVisible();
  const svgBox = (await deleteBtn.locator("svg").boundingBox())!;
  expect(svgBox.width).toBeGreaterThanOrEqual(12);
  expect(svgBox.height).toBeGreaterThanOrEqual(12);
  await deleteBtn.click();
  await expect(page.getByText("No conversations yet.")).toBeVisible();
  await drawer.getByRole("button", { name: "Close logs" }).click();

  // Editor: <main> landmark, non-overlapping toast, and Fit zoom keeps Trigger + step kickers unclipped.
  const wf = await (await page.request.post("/workflows", { data: { name: "Booking deposit flow", slug: `fit-${Date.now()}` } })).json();
  const tallDef = {
    trigger: {
      type: "form",
      config: {
        fields: [
          { name: "email", label: "Email", type: "email", required: true },
          { name: "room", label: "Room", type: "resource", required: true },
          { name: "checkin", label: "Check in", type: "datetime", timezone: "Asia/Manila", slotMinutes: 60, required: true },
        ],
      },
    },
    steps: [
      { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.room}}", start: "{{trigger.checkin}}", minutes: 60 } },
      { id: "send_pay_link", type: "paymongo_link", config: { amount: "1000.00", description: "Deposit", reference: "{{steps.book.output.reference}}" } },
      { id: "wait_6h", type: "delay", config: { seconds: 21600 } },
      { id: "check_paid", type: "payment_status", config: { due: "{{steps.send_pay_link.output.paymentId}}" } },
      { id: "paid_mail", type: "email", config: { to: "{{trigger.email}}", subject: "Confirmed", text: "Paid" } },
      { id: "still_unpaid", type: "email", config: { to: "{{trigger.email}}", subject: "Reminder", text: "Please pay" } },
    ],
    edges: [
      { from: "book", to: "send_pay_link", on: "done" },
      { from: "send_pay_link", to: "wait_6h" },
      { from: "wait_6h", to: "check_paid" },
      { from: "check_paid", to: "paid_mail", on: "paid" },
      { from: "check_paid", to: "still_unpaid", on: "pending" },
    ],
  };
  await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition: tallDef, publish: false } });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/w/${wf.id}`);

  await expect(page.locator("main.a7-editor")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Booking deposit flow", level: 1 })).toBeVisible();

  // Trigger a global toast and verify it does not overlap breadcrumb or title.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("kymavo:toast", { detail: { message: "Created draft from template.", tone: "success" } }));
  });
  const toast = page.locator(".rare-toast").filter({ hasText: "Created draft from template." });
  await expect(toast).toBeVisible();
  const [toastBox, headBox] = [(await toast.boundingBox())!, (await page.locator(".a7-head-main").boundingBox())!];
  const overlapsHeader =
    toastBox.x < headBox.x + headBox.width &&
    headBox.x < toastBox.x + toastBox.width &&
    toastBox.y < headBox.y + headBox.height &&
    headBox.y < toastBox.y + toastBox.height;
  expect(overlapsHeader).toBe(false);

  // Click Fit and verify Trigger node stays visible inside .a7-flow and step kickers do not clip.
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(250);
  const flowBox = (await page.locator(".a7-flow").boundingBox())!;
  const triggerBox = (await page.locator('.react-flow__node[data-id="trigger"]').boundingBox())!;
  expect(triggerBox.y).toBeGreaterThanOrEqual(flowBox.y - 2);
  expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(flowBox.y + flowBox.height + 2);

  const clippedKickers = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".a7-node-kicker")]
      .filter((el) => el.scrollWidth > el.clientWidth + 2)
      .map((el) => el.textContent),
  );
  expect(clippedKickers).toEqual([]);
});

test("390x844 mobile has zero overflow, clear drawer links, consistent Menu typography, clean booking List cards and More toolbar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, "f5-mobile");

  // Bottom bar Menu button matches sibling link typography.
  const navLink = page.locator(".bottom-bar a").first();
  const menuBtn = page.getByRole("button", { name: "Menu", exact: true });
  const [linkStyle, menuStyle] = await Promise.all([
    navLink.evaluate((el) => ({ fontSize: getComputedStyle(el).fontSize, fontWeight: getComputedStyle(el).fontWeight })),
    menuBtn.evaluate((el) => ({ fontSize: getComputedStyle(el).fontSize, fontWeight: getComputedStyle(el).fontWeight })),
  ]);
  expect(menuStyle).toEqual(linkStyle);

  // Open Menu drawer and verify Account and Sign out are above .bottom-bar with zero occlusion.
  await menuBtn.click();
  const nav = page.locator("#main-menu");
  await expect(nav).toBeVisible();
  const signOutBtn = nav.getByRole("button", { name: "Sign out", exact: true });
  const accountLink = nav.getByRole("link", { name: "Account", exact: true });
  await signOutBtn.scrollIntoViewIfNeeded();
  const [bottomBarBox, accountBox, signOutBox] = [
    (await page.locator(".bottom-bar").boundingBox())!,
    (await accountLink.boundingBox())!,
    (await signOutBtn.boundingBox())!,
  ];
  expect(accountBox.y + accountBox.height).toBeLessThanOrEqual(bottomBarBox.y + 1);
  expect(signOutBox.y + signOutBox.height).toBeLessThanOrEqual(bottomBarBox.y + 1);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  // Check zero horizontal overflow across #/, #/apps, #/knowledge, #/ai.
  for (const hash of ["#/", "#/apps", "#/knowledge", "#/ai"]) {
    await page.goto(`/${hash}`);
    await page.waitForTimeout(150);
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflows, `horizontal overflow on ${hash}`).toBe(false);
  }

  // Editor on 390x844: collapsed toolbar (Save, Publish, More) and booking List card never overlaps Move Up.
  const wf = await (await page.request.post("/workflows", { data: { name: "Mobile booking", slug: `mob-${Date.now()}` } })).json();
  const bookingDef = {
    trigger: {
      type: "form",
      config: {
        fields: [
          { name: "room", label: "Who or what to book", type: "resource", required: true },
          { name: "start_at", label: "When", type: "datetime", timezone: "Asia/Manila", slotMinutes: 60, required: true },
        ],
      },
    },
    steps: [
      { id: "first", type: "delay", config: { seconds: 60 } },
      { id: "book", type: "booking", config: { action: "create", resource: "{{trigger.room}}", start: "{{trigger.start_at}}", minutes: 60 } },
    ],
    edges: [{ from: "first", to: "book" }],
  };
  await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition: bookingDef, publish: false } });
  await page.goto(`/#/w/${wf.id}`);
  await expect(page.getByRole("heading", { name: "Mobile booking", level: 1 })).toBeVisible();

  const overflowEditor = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflowEditor).toBe(false);

  // Booking List card button must not overlap the Move Up button.
  const bookCardBtn = page.locator(".a7-list > li").nth(2).locator("> button").first();
  const bookUpBtn = page.getByRole("button", { name: "Move book up" });
  await expect(bookCardBtn).toBeVisible();
  const [cardBox, upBox] = [(await bookCardBtn.boundingBox())!, (await bookUpBtn.boundingBox())!];
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(upBox.x + 1);

  // Mobile toolbar collapses Test run / Explain into More sheet, while Save / Publish / More stay >= 44px.
  const toolbar = page.getByRole("group", { name: "Automation actions" });
  await expect(toolbar.getByRole("button")).toHaveText(["Save", "Publish", "More"]);
  await expect(toolbar.getByRole("button", { name: "Test run" })).toHaveCount(0);
  await toolbar.getByRole("button", { name: "More", exact: true }).click();
  const moreDialog = page.getByRole("dialog", { name: "More" });
  await expect(moreDialog).toBeVisible();
  await expect(moreDialog.getByRole("button", { name: "Test run", exact: true })).toBeVisible();
  await expect(moreDialog.getByRole("button", { name: "Explain this flow", exact: true })).toBeVisible();
});
