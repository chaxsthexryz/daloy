/** Brand kit rules shared by the API (validation) and the pages and emails (readable colours). */
export const ACCENT = /^#[0-9a-f]{6}$/;
export const LOGO_MAX_BYTES = 100 * 1024;
export type LogoType = "png" | "jpeg" | "webp";
export const LOGO_MIME: Record<LogoType, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

const startsWith = (b: Uint8Array, at: number, ...sig: number[]) => sig.every((v, i) => b[at + i] === v);

/** The type from the file's own first bytes. What the browser says it is does not count; SVG and everything else gives null. */
export function logoType(b: Uint8Array): LogoType | null {
  if (startsWith(b, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (startsWith(b, 0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (startsWith(b, 0, 0x52, 0x49, 0x46, 0x46) && startsWith(b, 8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => 0.2126 * channel(parseInt(hex.slice(1, 3), 16)) + 0.7152 * channel(parseInt(hex.slice(3, 5), 16)) + 0.0722 * channel(parseInt(hex.slice(5, 7), 16));

/** White or near-black text, whichever has the higher WCAG contrast on this accent. */
export function inkFor(accent: string): "#ffffff" | "#111111" {
  const l = luminance(accent);
  return 1.05 / (l + 0.05) >= (l + 0.05) / (luminance("#111111") + 0.05) ? "#ffffff" : "#111111";
}
