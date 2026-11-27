import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// The API has no path prefix, so the dev server forwards each of its routes. Same origin keeps the session cookie simple.
const API_ROUTES = ["/auth", "/workflows", "/runs", "/secrets", "/tokens", "/settings", "/ai", "/hooks", "/forms", "/approvals", "/mcp", "/step-schemas", "/templates", "/deliveries", "/workspace", "/my", "/bookings", "/payments", "/pay", "/events"];
const target = process.env.API_URL ?? "http://localhost:3000";
const here = import.meta.dirname;

export default defineConfig(({ mode }) =>
  // `vite build --mode site` builds only the public demo, with relative paths, into the landing site (decision 0037).
  mode === "site"
    ? { plugins: [react()], root: resolve(here, "demo"), base: "./", publicDir: resolve(here, "public"), build: { outDir: resolve(here, "../../site/demo"), emptyOutDir: true } }
    : {
        plugins: [react()],
        server: { port: 5173, proxy: Object.fromEntries(API_ROUTES.map((r) => [r, target])) },
        // The demo is a second page so the API serves it at /demo/ for Playwright.
        build: { rolldownOptions: { input: { main: resolve(here, "index.html"), demo: resolve(here, "demo/index.html") } } },
      },
);
