import { describe, expect, it } from "vitest";
import { FILE_MIME, fileType, safeFileName } from "./file-type";

const bytes = (...v: number[]) => Uint8Array.from(v);
const ftyp = (brand: string) => Uint8Array.from([0, 0, 0, 24, ...Buffer.from(`ftyp${brand}`), 0, 0, 0, 0]);

describe("fileType", () => {
  it("knows the image types the logo check knows", () => {
    expect(fileType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("png");
    expect(fileType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
  });
  it("reads HEIC by its ftyp brand", () => {
    for (const b of ["heic", "mif1", "heif", "hevc"]) expect(fileType(ftyp(b))).toBe("heic");
    expect(fileType(ftyp("isom"))).toBeNull();
    expect(fileType(ftyp("mp42"))).toBeNull();
  });
  it("reads a PDF by its header", () => {
    expect(fileType(Buffer.from("%PDF-1.7\n"))).toBe("pdf");
    expect(fileType(Buffer.from("%PDF"))).toBeNull();
  });
  it("refuses everything else", () => {
    expect(fileType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(fileType(Buffer.from("MZ\u0090\u0000"))).toBeNull();
    expect(fileType(new Uint8Array())).toBeNull();
  });
  it("has a mime type for every kind", () => {
    expect(FILE_MIME).toMatchObject({ heic: "image/heic", pdf: "application/pdf", png: "image/png", jpeg: "image/jpeg", webp: "image/webp" });
  });
});

describe("safeFileName", () => {
  it("drops folders from either kind of slash", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName(String.raw`C:\Users\me\receipt.pdf`)).toBe("receipt.pdf");
  });
  it("replaces control and reserved characters", () => {
    expect(safeFileName('a"b<c>d:e*f?g|h\u0000i\n.pdf')).toBe("a_b_c_d_e_f_g_h_i_.pdf");
  });
  it("trims, caps at 120 characters and never returns an empty name", () => {
    expect(safeFileName("  x.png  ")).toBe("x.png");
    expect(safeFileName("a".repeat(300))).toHaveLength(120);
    expect(safeFileName("")).toBe("file");
    expect(safeFileName("folder/")).toBe("file");
  });
  it("composes accents to NFC", () => {
    expect(safeFileName("cafe\u0301.pdf")).toBe("caf\u00e9.pdf");
  });
});
