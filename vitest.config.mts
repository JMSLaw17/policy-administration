import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
    // The integration tests share one database, so run test files one at a time.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "server-only": path("./test/server-only-stub.ts"),
      "@": path("./src"),
    },
  },
});
