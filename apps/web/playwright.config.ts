import { defineConfig, devices } from "@playwright/test";

// Admin specs require a logged-in admin storage state. Only register the admin
// project when its credentials are provisioned — otherwise binding a missing
// storage-state file would error, so we skip the project (and the spec) cleanly.
const hasAdminCreds = !!process.env.E2E_ADMIN_EMAIL && !!process.env.E2E_ADMIN_PASSWORD;

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

    // Desktop — runs all tests except auth setup and responsive-only tests
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
      testIgnore: [/auth\.setup\.ts/, /responsive\.spec\.ts/, /admin\.spec\.ts/],
    },

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

    // Admin — runs admin specs with an authenticated admin storage state.
    // Only registered when admin credentials are provisioned (see above).
    ...(hasAdminCreds
      ? [
          {
            name: "chromium-admin",
            use: {
              ...devices["Desktop Chrome"],
              storageState: "e2e/.auth/admin.json",
            },
            dependencies: ["setup"],
            testMatch: /admin\.spec\.ts/,
          },
        ]
      : []),
  ],
  webServer: {
    command: process.env.CI ? "pnpm start" : "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
