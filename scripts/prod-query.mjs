#!/usr/bin/env node
/**
 * Read-only look at the deployed app's database, for checking that something
 * worked in production (a payment, a signature, a refund).
 *
 *   npm run prod:query                       summary of recent activity
 *   npm run prod:query -- "select ..."       one SELECT statement
 *
 * The connection string is read from .env.production.local (PROD_DATABASE_URL),
 * which git ignores. It is never printed.
 *
 * This script cannot change data, enforced three ways:
 *   1. The session is set to read-only, so Postgres itself rejects writes.
 *   2. Every query runs inside a READ ONLY transaction that is rolled back.
 *   3. Queries are sent as prepared statements, which allow only a single
 *      statement, so a query can't end the transaction and start a new one.
 */
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

const ENV_FILE = ".env.production.local";

function connectionString() {
  if (!existsSync(ENV_FILE)) fail(`${ENV_FILE} not found. Create it with a PROD_DATABASE_URL line.`);
  const line = readFileSync(ENV_FILE, "utf8")
    .split("\n")
    .find((l) => l.trim().startsWith("PROD_DATABASE_URL="));
  const value = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  if (!value) fail(`${ENV_FILE} has no PROD_DATABASE_URL value.`);
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const SUMMARY = [
  ["Row counts", `
    select 'customers' as "table", count(*)::int as rows from "Customer"
    union all select 'policies', count(*)::int from "Policy"
    union all select 'applications', count(*)::int from "Application"
    union all select 'payments', count(*)::int from "Payment"
    union all select 'refunds', count(*)::int from "Refund"
    union all select 'claims', count(*)::int from "Claim"
    union all select 'integration events', count(*)::int from "IntegrationEvent"`],
  ["Policies", `
    select p."policyNumber" as policy, c."businessName" as customer, p.status,
           p."startDate"::text as starts, coalesce(sum(l."amountCents"), 0)::int as balance_cents
    from "Policy" p join "Customer" c on c.id = p."customerId"
    left join "LedgerEntry" l on l."policyId" = p.id
    group by p.id, c."businessName" order by p."createdAt"`],
  ["Applications (DocuSign)", `
    select a.status, left(a."docusignEnvelopeId", 8) as envelope, a."signerName" as signer,
           to_char(a."signedAt", 'YYYY-MM-DD HH24:MI:SS') as signed_utc, p."policyNumber" as policy
    from "Application" a left join "Policy" p on p.id = a."policyId" order by a."createdAt"`],
  ["Payments and refunds (Stripe)", `
    select 'payment' as kind, p.status::text, p."amountCents" as cents, pol."policyNumber" as policy,
           to_char(p."createdAt", 'YYYY-MM-DD HH24:MI:SS') as created_utc
    from "Payment" p join "Policy" pol on pol.id = p."policyId"
    union all
    select 'refund', r.status::text, r."amountCents", pol."policyNumber",
           to_char(r."createdAt", 'YYYY-MM-DD HH24:MI:SS')
    from "Refund" r join "Policy" pol on pol.id = r."policyId"
    order by created_utc`],
  ["Last 20 integration events", `
    select to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS') as utc, provider, direction::text, "eventType" as event
    from "IntegrationEvent" order by "createdAt" desc limit 20`],
];

const sql = process.argv.slice(2).join(" ").trim();
const client = new pg.Client({ connectionString: connectionString() });

try {
  await client.connect();
  // Sent as a statement, not a startup option, because connection poolers reject startup options.
  await client.query("SET default_transaction_read_only = on");
  const run = async (text) => {
    await client.query("BEGIN TRANSACTION READ ONLY");
    try {
      // A named (prepared) statement can only contain one statement.
      return await client.query({ name: `q${Math.random().toString(36).slice(2)}`, text });
    } finally {
      await client.query("ROLLBACK");
    }
  };

  if (sql) {
    const result = await run(sql);
    console.table(result.rows);
    console.log(`${result.rowCount} row(s)`);
  } else {
    for (const [title, text] of SUMMARY) {
      console.log(`\n${title}`);
      console.table((await run(text)).rows);
    }
  }
} catch (error) {
  // Never echo the connection string; pg error messages don't include it.
  fail(`Query failed: ${error.message}`);
} finally {
  await client.end().catch(() => {});
}
