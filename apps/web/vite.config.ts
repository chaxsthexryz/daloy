import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API has no path prefix, so the dev server forwards each of its routes. Same origin keeps the session cookie simple.
const API_ROUTES = ["/auth", "/workflows", "/runs", "/secrets", "/tokens", "/settings", "/ai", "/hooks", "/forms", "/approvals", "/mcp", "/step-schemas", "/templates"];
const target = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: Object.fromEntries(API_ROUTES.map((r) => [r, target])) },
});
