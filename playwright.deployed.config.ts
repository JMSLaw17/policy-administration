import { defineConfig } from "@playwright/test";

/**
 * Checks refunds and claims on a deployed copy of the app, in a real browser.
 * Unlike `npm run smoke`, this one CHANGES DATA: it makes a Stripe test-mode
 * payment and refund, and files two claims, on an existing policy.
 *
 *   npm run test:deployed                          the deployed site, policy SBP-2026-0002
 *   POLICY=SBP-2026-0009 npm run test:deployed     a different policy
 *   DEPLOYED_URL=http://localhost:3100 POLICY=... npm run test:deployed
 */
export default defineConfig({
  testDir: "deployed",
  timeout: 300_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.DEPLOYED_URL ?? "https://policy-administration.vercel.app",
    channel: "chrome",
    actionTimeout: 30_000,
    trace: "off",
    screenshot: "only-on-failure",
  },
  outputDir: "test-results/deployed",
});
