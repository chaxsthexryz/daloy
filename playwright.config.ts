import { defineConfig, devices } from "@playwright/test";

// e2e/global-setup.ts starts Postgres, the API (serving the built console) and the worker on port 3100.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 90_000,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
