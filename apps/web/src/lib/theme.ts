export type Theme = "system" | "light" | "dark";

const KEY = "daloy:theme";
const DARK = "(prefers-color-scheme: dark)";

/** Light or dark for a saved choice; anything unknown counts as System. public/theme.js does the same before the first paint. */
export const resolveTheme = (choice: string | null, systemDark: boolean): "light" | "dark" =>
  choice === "light" || choice === "dark" ? choice : systemDark ? "dark" : "light";

/** The choice saved on this device (per device, so it needs no account setting). */
export function savedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const applyTheme = (choice: Theme) => (document.documentElement.dataset.theme = resolveTheme(choice, matchMedia(DARK).matches));

export function saveTheme(choice: Theme) {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice still applies until the page is closed.
  }
  applyTheme(choice);
}

/** Keeps System in step when the device switches between light and dark. */
export const followSystemTheme = () => matchMedia(DARK).addEventListener("change", () => applyTheme(savedTheme()));
