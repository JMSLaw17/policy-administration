#!/usr/bin/env node
/**
 * Starts a copy of the app for the browser tests, on port 3200, against its
 * own database (policy_admin_e2e) so the tests never touch development data.
 *
 * DocuSign is switched off for this copy. Signing happens on DocuSign's own
 * page, which can't be automated reliably, so here the broker issues a policy
 * directly. Stripe stays on, in test mode.
 */
import { execFileSync, spawn } from "node:child_process";
import pg from "pg";

process.loadEnvFile(".env");

const PORT = "3200";
const url = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error("Refusing to run browser tests against a database that isn't local.");
}
url.pathname = "/policy_admin_e2e";

const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  // An empty value still counts as "set", so Next.js won't refill these from .env.
  DOCUSIGN_INTEGRATION_KEY: "",
  DOCUSIGN_PRIVATE_KEY_BASE64: "",
};
delete env.DATABASE_URL_UNPOOLED;

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'policy_admin_e2e'");
if (exists.rowCount === 0) await admin.query("CREATE DATABASE policy_admin_e2e");
await admin.end();

const run = (args) => execFileSync("npx", args, { env, stdio: "inherit" });
run(["prisma", "migrate", "deploy"]);

// Start every run from the same clean state: just the two demo logins.
const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
await db.query(
  'TRUNCATE "Claim", "Application", "IntegrationEvent", "LedgerEntry", "Refund", "Payment", "PolicyTransaction", "Policy", "User", "Customer" RESTART IDENTITY CASCADE',
);
await db.end();
run(["prisma", "db", "seed"]);

run(["next", "build"]);
const server = spawn("npx", ["next", "start", "-p", PORT], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
