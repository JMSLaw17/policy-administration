import { defineConfig } from "@playwright/test";

/**
 * Takes the evidence screenshots in docs/evidence/screenshots by running the
 * reviewers' scenario on a deployed copy of the app. Like `npm run
 * test:deployed`, it CHANGES DATA: it loads one demo scenario (a new customer,
 * a policy, and real Stripe test payments) and corrects it twice.
 *
 *   npm run evidence:screenshots
 *   DEPLOYED_URL=http://localhost:3100 npm run evidence:screenshots
 */
export default defineConfig({
  testDir: "evidence",
  timeout: 300_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.DEPLOYED_URL ?? "https://policy-administration.vercel.app",
    channel: "chrome",
    actionTimeout: 30_000,
    viewport: { width: 1280, height: 900 },
    trace: "off",
  },
  outputDir: "test-results/evidence",
});
