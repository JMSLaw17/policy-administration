import { defineConfig } from "@playwright/test";

/**
 * Browser tests of the whole app, including Stripe's real card form in test
 * mode. Run with `npm run test:e2e`. They use the Chrome already installed on
 * this machine and a separate copy of the app (see scripts/e2e-server.mjs).
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 300_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3200",
    channel: "chrome",
    actionTimeout: 20_000,
    trace: "off",
    screenshot: "only-on-failure",
  },
  outputDir: "test-results",
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://localhost:3200/login",
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
