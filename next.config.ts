import type { NextConfig } from "next";

// Cache Components is off on purpose: every page here is per-user financial
// data that must be fresh on each request (see DECISIONS.md).
const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
