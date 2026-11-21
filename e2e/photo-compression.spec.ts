import { expect, test } from "@playwright/test";

// R5: a photo chosen on a public form is shrunk in the visitor's browser before it uploads, and the form still submits.
// The server's own type and size checks stay (form-files.spec.ts, form-files.test.ts).
test("a large photo is resized to 2000 px and re-encoded as a JPEG before upload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email").fill(`squeeze-${Date.now()}@test.local`);
  await page.getByLabel("Password").fill("e2e test password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

  const wf = await (await page.request.post("/workflows", { data: { name: "Photo intake", slug: `photo-${Date.now()}` } })).json();
  const definition = {
    trigger: { type: "form", config: { fields: [{ name: "photo", label: "Photo", type: "file", required: true }] } },
    steps: [{ id: "wait", type: "delay", config: { seconds: 1 } }],
    edges: [],
  };
  expect((await page.request.post(`/workflows/${wf.id}/versions`, { data: { definition, publish: true } })).status()).toBe(201);
  const formId = ((await (await page.request.get(`/workflows/${wf.id}`)).json()) as { trigger: { id: string } }).trigger.id;

  await page.goto(`/forms/${formId}`);
  const result = await page.evaluate(async () => {
    // A 3000 x 2000 PNG with many colours, like a camera photo, chosen the way a person would: through the file input.
    const c = document.createElement("canvas");
    c.width = 3000;
    c.height = 2000;
    const x = c.getContext("2d")!;
    // A smooth scene with sensor noise: flat colours would make a tiny PNG that a JPEG cannot beat, and the script keeps the smaller file.
    const img = x.createImageData(3000, 2000);
    for (let p = 0; p < img.data.length; p += 4) {
      const px = (p / 4) % 3000;
      const py = Math.floor(p / 4 / 3000);
      const n = Math.random() * 40 - 20;
      img.data[p] = px / 12 + n;
      img.data[p + 1] = py / 9 + n;
      img.data[p + 2] = 128 + n;
      img.data[p + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    const png = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const dt = new DataTransfer();
    dt.items.add(new File([png], "receipt.png", { type: "image/png" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // The submit button is held until the compressor is done.
    const button = document.querySelector<HTMLButtonElement>("button[type=submit]")!;
    const heldAtFirst = button.disabled;
    for (let i = 0; i < 100 && button.disabled; i++) await new Promise((r) => setTimeout(r, 100));
    const f = input.files![0]!;
    const bmp = await createImageBitmap(f);
    return { heldAtFirst, released: !button.disabled, name: f.name, type: f.type, size: f.size, originalSize: png.size, width: bmp.width, height: bmp.height };
  });
  expect(result.heldAtFirst).toBe(true);
  expect(result.released).toBe(true);
  expect(result).toMatchObject({ name: "receipt.jpg", type: "image/jpeg", width: 2000, height: 1333 });
  expect(result.size).toBeLessThan(result.originalSize);

  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Thanks, we received your message.")).toBeVisible();
});
