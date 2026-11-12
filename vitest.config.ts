import { defineConfig } from "vitest/config";

// e2e/ holds the Playwright tests, which run with `pnpm e2e`.
export default defineConfig({ test: { globalSetup: ["./test/global-setup.ts"], exclude: ["**/node_modules/**", "e2e/**"] } });
