import { useState } from "react";

/** Marks that have a picture in public/logos. Everything else (UniSMS, PayMongo, GCash, Messenger, Instagram, kymavo actions) is an icon or a letter tile. Reasons: public/logos/README.md. */
export const LOGOS = ["gmail", "outlook", "google-sheets", "google-drive", "google-docs", "google-calendar", "slack", "teams", "telegram", "airtable", "notion", "trello", "shopify", "discord"] as const;
const hasLogo = (mark: string): boolean => (LOGOS as readonly string[]).includes(mark);

/** The app keys the Apps page and the catalog use mapped to a logo file name. */
export const APP_LOGO: Record<string, string> = {
  gmail: "gmail",
  outlook: "outlook",
  google_sheets: "google-sheets",
  google_drive: "google-drive",
  google_calendar: "google-calendar",
  slack: "slack",
  teams: "teams",
  telegram: "telegram",
  airtable: "airtable",
  notion: "notion",
  trello: "trello",
  discord: "discord",
  shopify: "shopify",
};

// kymavo's own line icons for built-in actions: 24px grid, 1.8 stroke, currentColor.
const ICONS: Record<string, string> = {
  branch: "M6 3v8a4 4 0 0 0 4 4h4M18 21v-8M6 3 3 6m3-3 3 3M18 21l-3-3m3 3 3-3",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c2.5 2.4 3.8 5.4 3.8 9s-1.3 6.6-3.8 9c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3Z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5V12l3 2",
  ai: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Zm7 12 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z",
  "person-check": "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 10v-1a6 6 0 0 1 6-6h1m5 5 2 2 4-4",
  calendar: "M4 6h16v14H4V6Zm0 5h16M8 3v4m8-4v4",
  play: "M7 4.5v15l12-7.5-12-7.5Z",
  mail: "M3 6h18v12H3V6Zm0 1 9 6 9-6",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  form: "M5 3h14v18H5V3Zm3 5h8m-8 4h8m-8 4h5",
};

/** Marks drawn as a letter tile because no usable logo exists (public/logos/README.md says why). */
export const LETTER_TILES = ["unisms", "paymongo", "gcash", "messenger", "instagram", "whatsapp"] as const;
export const ICON_KEYS = Object.keys(ICONS);

/**
 * One app or action mark. A logo shows as a picture; an action kymavo does itself shows a line icon; an app without a
 * usable logo shows its first letter. The wrapper always carries the app's name, so a screen reader and a failed image
 * both fall back to text. Next to text that already names the app (a node, a list row), pass decorative so it is not read twice. The padding around the picture is the clear space (at least a fifth of the logo's width).
 */
export function AppMark({ mark, name, size = 28, decorative = false }: { mark: string; name: string; size?: number; decorative?: boolean }) {
  const [failed, setFailed] = useState(false);
  const logo = hasLogo(mark) && !failed;
  const icon = !logo && ICONS[mark];
  const inner = Math.round(size * 0.62);
  return (
    <span className="app-mark" data-mark={mark} data-kind={logo ? "logo" : icon ? "icon" : "letter"} {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })} style={{ width: size, height: size }}>
      {logo ? (
        <img src={`${import.meta.env.BASE_URL}logos/${mark}.svg`} alt="" width={inner} height={inner} draggable={false} onError={() => setFailed(true)} />
      ) : icon ? (
        <svg viewBox="0 0 24 24" width={inner} height={inner} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg>
      ) : (
        <span aria-hidden="true">{name.trim()[0]?.toUpperCase() ?? "?"}</span>
      )}
    </span>
  );
}
