import { LOGO_MIME, logoType, type LogoType } from "./brand";

/** Limits for files sent through a hosted form. */
export const FILE_MAX_BYTES = 5 * 1024 * 1024;
export const FILES_PER_FIELD = 3;
export const FILES_PER_SUBMISSION = 5;

export type FileKind = LogoType | "heic" | "pdf";
export const FILE_MIME: Record<FileKind, string> = { ...LOGO_MIME, heic: "image/heic", pdf: "application/pdf" };

/** A stored upload as the run's payload carries it. The bytes stay in the database. */
export type FileRef = { id: string; name: string; type: FileKind; size: number };

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "heif"]);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** The type from the file's own first bytes. What the browser says it is does not count; anything else gives null. */
export function fileType(b: Uint8Array): FileKind | null {
  const image = logoType(b);
  if (image) return image;
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(b, 8, 12))) return "heic";
  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return "pdf";
  return null;
}

/** A name safe to store and to put in a header: no folders, no control characters, no characters Windows refuses. */
export function safeFileName(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
  const clean = base.normalize("NFC").replace(/[\u0000-\u001f\u007f"<>:*?|]/g, "_").trim().slice(0, 120).trim();
  return clean === "" ? "file" : clean;
}
