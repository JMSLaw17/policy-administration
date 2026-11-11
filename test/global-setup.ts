import "dotenv/config";
import { execFileSync } from "node:child_process";
import pg from "pg";

/**
 * Integration tests run against their own database, never the development
 * one. It is created if missing and migrated before the tests start.
 */
export function testDatabaseUrl() {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("Refusing to run integration tests against a database that isn't local.");
  }
  url.pathname = "/policy_admin_test";
  return url.toString();
}

export default async function setup() {
  const testUrl = testDatabaseUrl();
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'policy_admin_test'");
  if (exists.rowCount === 0) await admin.query("CREATE DATABASE policy_admin_test");
  await admin.end();

  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: testUrl };
  delete env.DATABASE_URL_UNPOOLED;
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env,
    stdio: "pipe",
  });
  process.env.TEST_DATABASE_URL = testUrl;
}
