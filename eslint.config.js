import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  { ignores: ["**/node_modules", "**/dist", "**/coverage", "docs/design", "site/demo", ".claude"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  // The landing page's one hand-written script runs in the browser.
  { files: ["site/*.js"], languageOptions: { globals: { window: "readonly", document: "readonly", matchMedia: "readonly", IntersectionObserver: "readonly", MutationObserver: "readonly" } } },
]);
