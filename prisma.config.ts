import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Migrations need a direct connection. On Vercel + Neon that is
    // DATABASE_URL_UNPOOLED; locally DATABASE_URL is already direct.
    url: process.env.DATABASE_URL_UNPOOLED ?? env("DATABASE_URL"),
  },
});
