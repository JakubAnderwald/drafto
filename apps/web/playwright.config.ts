import { defineConfig, devices } from "@playwright/test";
import { getAdminCredentials } from "./e2e/helpers/admin-credentials";

// Admin specs run as a separate admin account. Their projects are only registered
// when the admin E2E variables are set — otherwise the admin setup step is
// skipped, no storage-state file is written, and the project would fail to load it.
const hasAdminCredentials = getAdminCredentials() !== null;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    // Auth setup — runs first, saves storage state for other projects
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },

    // Desktop — runs all tests except auth setup, responsive-only and admin-only tests
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
      testIgnore: [/auth\.setup\.ts/, /responsive\.spec\.ts/, /admin\.spec\.ts/],
    },

    // Admin — only runs admin specs, signed in as the admin account. The admin
    // login is its own setup project: Playwright skips every dependent of a
    // setup project that fails, so a broken admin login in the shared "setup"
    // project would skip the whole suite instead of just the admin specs.
    ...(hasAdminCredentials
      ? [
          {
            name: "setup-admin",
            testMatch: /admin\.setup\.ts/,
          },
          {
            name: "chromium-admin",
            use: {
              ...devices["Desktop Chrome"],
              storageState: "e2e/.auth/admin.json",
            },
            dependencies: ["setup", "setup-admin"],
            testMatch: /admin\.spec\.ts/,
          },
        ]
      : []),

    // Mobile — only runs responsive tests (desktop tests assume three-panel layout)
    {
      name: "Mobile Chrome",
      use: {
        ...devices["Pixel 5"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
      testMatch: /responsive\.spec\.ts/,
    },
    {
      name: "Mobile Safari",
      use: {
        ...devices["iPhone 13"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
      testMatch: /responsive\.spec\.ts/,
    },

    // Tablet — only runs responsive tests
    {
      name: "Tablet",
      use: {
        ...devices["iPad (gen 7)"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
      testMatch: /responsive\.spec\.ts/,
    },
  ],
  webServer: {
    command: process.env.CI ? "pnpm start" : "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
