import { defineConfig } from "@playwright/test";

/**
 * A quick read-only check of a deployed copy of the app: signs in as each demo
 * user and opens the main pages. It never clicks anything that changes data.
 * Run with `npm run smoke` (the deployed site) or
 * `SMOKE_URL=http://localhost:3000 npm run smoke` (your dev server).
 */
export default defineConfig({
  testDir: "smoke",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.SMOKE_URL ?? "https://policy-administration.vercel.app",
    channel: process.env.SMOKE_CHANNEL ?? "chrome",
    trace: "off",
    screenshot: "only-on-failure",
  },
  outputDir: "test-results/smoke",
});
