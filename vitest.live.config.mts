import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Tests that talk to the real Stripe test mode. Kept out of `npm test` so the
 * ordinary suite stays fast and offline. Run with `npm run test:stripe`.
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "server-only": path("./test/server-only-stub.ts"),
      "@": path("./src"),
    },
  },
});
