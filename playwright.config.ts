import { defineConfig, devices } from "@playwright/test";

// End-to-end tests: the real front end (npm run dev) against the LOCAL
// Supabase stack, signed in as the test accounts in
// tests/fixtures/local-users.json (npm run seed:local creates them).
const PORT = Number(process.env.E2E_PORT || 3000);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1360, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: {
    command: "npm run dev",
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT), APP_URL: `http://localhost:${PORT}` },
    timeout: 60_000,
  },
});
