import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { COMPRESS_JS } from "./compress";

// R5: the phone-side compressor. The browser is faked: a file chooser, createImageBitmap and a canvas whose toBlob
// returns a blob of a size the test picks. The server's own type and size checks are covered in payments.test.ts and form-files.test.ts.
const file = (name: string, type: string, size: number) => new File([new Uint8Array(size)], name, { type });

function phone(opts: { dims?: [number, number]; blobSize?: number; decodeFails?: boolean } = {}) {
  const canvases: { width: number; height: number; quality?: number; mime?: string }[] = [];
  const button = { disabled: false };
  const listeners: Record<string, () => void> = {};
  const input = {
    files: [] as File[],
    form: { querySelectorAll: () => [button] },
    addEventListener: (ev: string, fn: () => void) => void (listeners[ev] = fn),
  };
  const ctx = {
    window: {},
    File,
    Blob,
    DataTransfer: class {
      items = { add: (f: File) => void this.list.push(f) };
      list: File[] = [];
      get files() {
        return this.list;
      }
    },
    createImageBitmap: async () => {
      if (opts.decodeFails) throw new Error("cannot decode");
      return { width: (opts.dims ?? [4000, 3000])[0], height: (opts.dims ?? [4000, 3000])[1], close() {} };
    },
    document: {
      querySelectorAll: () => [input],
      createElement: () => {
        const c: (typeof canvases)[number] & { getContext: () => object; toBlob: (cb: (b: Blob | null) => void, mime: string, q: number) => void } = {
          width: 0,
          height: 0,
          getContext: () => ({ fillRect() {}, drawImage() {}, set fillStyle(_v: string) {} }),
          toBlob(cb, mime, q) {
            c.mime = mime;
            c.quality = q;
            cb(new Blob([new Uint8Array(opts.blobSize ?? 400_000)], { type: mime }));
          },
        };
        canvases.push(c);
        return c;
      },
    },
  };
  vm.runInNewContext(COMPRESS_JS, ctx);
  const choose = async (...files: File[]) => {
    input.files = files;
    listeners.change!();
    expect(button.disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(button.disabled).toBe(false);
    return input.files as File[];
  };
  return { choose, canvases };
}

describe("receipt compression on the phone", () => {
  it("scales a large photo so its longest side is at most 2000 px and sends a smaller JPEG at quality 0.8", async () => {
    const p = phone({ dims: [4000, 3000], blobSize: 500_000 });
    const out = await p.choose(file("IMG_1.heic.png", "image/png", 6 * 1024 * 1024));
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("image/jpeg");
    expect(out[0]!.name).toBe("IMG_1.heic.jpg");
    expect(out[0]!.size).toBe(500_000);
    expect(p.canvases[0]).toMatchObject({ width: 2000, height: 1500, mime: "image/jpeg", quality: 0.8 });
  });

  it("keeps the proportions of a tall screenshot", async () => {
    const p = phone({ dims: [1080, 2400], blobSize: 200_000 });
    await p.choose(file("shot.png", "image/png", 2_000_000));
    expect(p.canvases[0]).toMatchObject({ width: 900, height: 2000 });
  });

  it("leaves a small image that already fits exactly as it is", async () => {
    const p = phone({ dims: [800, 600] });
    const f = file("small.jpg", "image/jpeg", 250 * 1024);
    expect((await p.choose(f))[0]).toBe(f);
    expect(p.canvases).toHaveLength(0);
  });

  it("recompresses a big file that already fits in pixels", async () => {
    const p = phone({ dims: [1800, 1200], blobSize: 300_000 });
    const out = await p.choose(file("big.jpg", "image/jpeg", 3 * 1024 * 1024));
    expect(out[0]!.size).toBe(300_000);
    expect(p.canvases[0]).toMatchObject({ width: 1800, height: 1200 });
  });

  it("keeps the original when the result would not be smaller", async () => {
    const p = phone({ dims: [4000, 3000], blobSize: 900_000 });
    const f = file("a.jpg", "image/jpeg", 800_000);
    expect((await p.choose(f))[0]).toBe(f);
  });

  it("does not touch PDFs, HEIC or other types, which the server judges by their bytes", async () => {
    const p = phone();
    const files = [file("a.pdf", "application/pdf", 3_000_000), file("b.heic", "image/heic", 3_000_000), file("c.txt", "text/plain", 3_000_000)];
    expect(await p.choose(...files)).toEqual(files);
    expect(p.canvases).toHaveLength(0);
  });

  it("sends the original when the browser cannot decode the image, and still re-enables the button", async () => {
    const p = phone({ decodeFails: true });
    const f = file("odd.png", "image/png", 4_000_000);
    expect((await p.choose(f))[0]).toBe(f);
  });

  it("handles several files, replacing only the ones it can shrink", async () => {
    const p = phone({ dims: [3000, 3000], blobSize: 100_000 });
    const a = file("a.jpg", "image/jpeg", 2_000_000);
    const pdf = file("b.pdf", "application/pdf", 1_000_000);
    const out = await p.choose(a, pdf);
    expect(out[0]!.size).toBe(100_000);
    expect(out[1]).toBe(pdf);
  });
});
