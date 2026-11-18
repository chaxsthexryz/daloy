import { defineConfig } from "vitest/config";

// e2e/ holds the Playwright tests, which run with `pnpm e2e`.
// Every test account signs up from 127.0.0.1, so the per-IP sign-up limit is raised; deploy.test.ts checks the limit itself.
export default defineConfig({ test: { globalSetup: ["./test/global-setup.ts"], exclude: ["**/node_modules/**", "e2e/**"], env: { REGISTER_LIMIT_PER_HOUR: "1000", SIGNUP_PLAN: "none" } } });
