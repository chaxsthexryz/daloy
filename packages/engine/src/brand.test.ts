import { describe, expect, it } from "vitest";
import { ACCENT, inkFor, logoType } from "./brand";

const bytes = (...n: number[]) => Uint8Array.from([...n, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe("logoType", () => {
  it("accepts PNG, JPEG and WebP by their first bytes", () => {
    expect(logoType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("png");
    expect(logoType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
    expect(logoType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]))).toBe("webp");
  });
  it("refuses SVG, HTML, GIF, WAV and empty files", () => {
    const text = (s: string) => new TextEncoder().encode(s);
    expect(logoType(text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(logoType(text("<html></html>"))).toBeNull();
    expect(logoType(text("GIF89a......"))).toBeNull();
    expect(logoType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
    expect(logoType(new Uint8Array())).toBeNull();
  });
});

describe("accent", () => {
  it("is a lowercase six digit hex", () => {
    expect(ACCENT.test("#1a73e8")).toBe(true);
    for (const bad of ["red", "#fff", "#1A73E8", "#1a73e8; x", "1a73e8", "#1a73e8ff", "url(x)"]) expect(ACCENT.test(bad)).toBe(false);
  });
  it("gets text that stays readable", () => {
    expect(inkFor("#0b3d91")).toBe("#ffffff");
    expect(inkFor("#ffe08a")).toBe("#111111");
    expect(inkFor("#000000")).toBe("#ffffff");
    expect(inkFor("#ffffff")).toBe("#111111");
  });
});
