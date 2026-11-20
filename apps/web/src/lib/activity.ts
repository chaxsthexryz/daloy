import type { Language } from "./locale";

// ICU puts a narrow no-break space before AM/PM; plain spaces keep copied text and test reads simple.
const plain = (s: string) => s.replace(/\s/g, " ");

/** "10:42 AM", or "10:42:03 AM" with seconds (the run timeline). Times read the same in English and Tagalog. */
export const clock = (iso: string, seconds = false) =>
  plain(new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: seconds ? "2-digit" : undefined }));

/** "Friday, 20 November 2026" (or the Tagalog form): the date under a page title. */
export const longDate = (at: number | string, language: Language = "en") =>
  plain(new Date(at).toLocaleDateString(language === "tl" ? "fil-PH" : "en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }));

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** When a run started, in the viewer's time: "Today, 10:42 AM", "Yesterday, 4:34 PM", "Nov 16, 9:12 AM". */
export function startedAt(iso: string, now = Date.now(), language: Language = "en"): string {
  const at = new Date(iso);
  const today = dayStart(new Date(now));
  const days = Math.round((today - dayStart(at)) / 86_400_000);
  const time = clock(iso);
  if (days <= 0) return `${language === "tl" ? "Ngayon" : "Today"}, ${time}`;
  if (days === 1) return `${language === "tl" ? "Kahapon" : "Yesterday"}, ${time}`;
  const sameYear = at.getFullYear() === new Date(now).getFullYear();
  return `${plain(at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" }))}, ${time}`;
}
