import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests for the booking flow. They run the dev server against the
 * Supabase dev project named in .env.local, create their own private
 * departures and delete them afterward. Not part of CI, which has no
 * database: run `npm run test:e2e` locally.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 45_000,
  use: {
    baseURL: "http://localhost:4321",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // On Windows, use the installed Microsoft Edge. Windows application
      // control can block the unsigned browser Playwright downloads; Edge is
      // signed and always present. Elsewhere, Playwright's own Chromium.
      use: {
        ...devices["Desktop Chrome"],
        ...(process.platform === "win32" ? { channel: "msedge" } : {}),
      },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:4321",
    reuseExistingServer: true,
    timeout: 90_000,
  },
});
