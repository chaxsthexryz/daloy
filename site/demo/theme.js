/* global document, localStorage, matchMedia */
// Sets the colour theme before the first paint, so a dark choice never flashes light. Same rule as resolveTheme in
// src/lib/theme.ts, which keeps it current afterwards. A separate file because the security headers allow no inline script.
var choice = null;
try {
  choice = localStorage.getItem("daloy:theme");
} catch {
  // Storage blocked: follow the device.
}
document.documentElement.dataset.theme =
  choice === "light" || choice === "dark" ? choice : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
