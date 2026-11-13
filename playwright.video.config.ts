import { defineConfig } from "@playwright/test";

/**
 * Records the submission video (video/record.spec.ts) on a deployed copy of
 * the app. Use `npm run video`, which also puts the finished video together;
 * see docs/video.md. Like `npm run evidence:screenshots`, it CHANGES DATA.
 *
 *   npm run video
 *   DEPLOYED_URL=http://localhost:3100 npm run video
 */
export default defineConfig({
  testDir: "video",
  timeout: 900_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.DEPLOYED_URL ?? "https://policy-administration.vercel.app",
    channel: "chrome",
    actionTimeout: 30_000,
    trace: "off",
  },
  outputDir: "test-results/video",
});
