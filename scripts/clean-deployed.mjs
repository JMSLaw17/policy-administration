#!/usr/bin/env node
/**
 * Removes leftover test data from the deployed app's database:
 *
 *   1. One whole policy and everything attached to it (statement lines,
 *      payments, refunds, claims, history, and its integration log rows).
 *   2. Stripe webhook rows in the integration log that belong to no policy.
 *      These were events from local and automated testing on the same Stripe
 *      test account, logged before the webhook learned to ignore them.
 *
 * A policy is removed whole or not at all. This never edits part of a
 * policy's history, which the app itself is built never to do.
 *
 *   npm run clean:deployed                                  lists what would be deleted
 *   npm run clean:deployed -- --confirm "delete SBP-2026-0001"   deletes it
 *   npm run clean:deployed -- --policy SBP-2026-0009 ...    a different policy
 *   npm run clean:deployed -- --local                       the local dev database, for trying it out
 *
 * It refuses to remove a policy that was issued from a signed application, or
 * that is renewed or is a renewal, since those are linked to other records.
 * Everything happens in one transaction: all of it, or none of it.
 */
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const local = args.includes("--local");
const policyNumber = option("--policy") ?? "SBP-2026-0001";
const confirmation = option("--confirm");
const expected = `delete ${policyNumber}`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function connectionString() {
  const file = local ? ".env" : ".env.production.local";
  const key = local ? "DATABASE_URL" : "PROD_DATABASE_URL";
  if (!existsSync(file)) fail(`${file} not found.`);
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.trim().startsWith(`${key}=`));
  const value = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  if (!value) fail(`${file} has no ${key} value.`);
  return value.replace(/sslmode=(require|prefer|verify-ca)\b/, "sslmode=verify-full");
}

const client = new pg.Client({ connectionString: connectionString() });
await client.connect();
const one = async (text, values = []) => (await client.query(text, values)).rows[0];

try {
  await client.query("BEGIN");

  const policy = await one(
    `select p.id, p."policyNumber", p.status::text, p."renewedFromId", c."businessName",
            (select count(*) from "Policy" r where r."renewedFromId" = p.id)::int as renewals,
            (select count(*) from "Application" a where a."policyId" = p.id)::int as applications
     from "Policy" p join "Customer" c on c.id = p."customerId" where p."policyNumber" = $1 for update of p`,
    [policyNumber],
  );
  if (!policy) fail(`No policy numbered ${policyNumber} in the ${local ? "local" : "deployed"} database.`);
  if (policy.renewals > 0 || policy.renewedFromId) fail(`${policyNumber} is linked to a renewal, so it can't be removed on its own.`);
  if (policy.applications > 0) fail(`${policyNumber} was issued from a signed application, so it is kept.`);

  // Children first, so no row is left pointing at something that's gone.
  const steps = [
    ["statement lines", `delete from "LedgerEntry" where "policyId" = $1`],
    ["refunds", `delete from "Refund" where "policyId" = $1`],
    ["payments", `delete from "Payment" where "policyId" = $1`],
    ["claims", `delete from "Claim" where "policyId" = $1`],
    ["integration log rows for this policy", `delete from "IntegrationEvent" where "policyId" = $1`],
    ["history entries", `delete from "PolicyTransaction" where "policyId" = $1`],
    ["policy", `delete from "Policy" where id = $1`],
  ];
  const deleted = [];
  for (const [label, sql] of steps) deleted.push([label, (await client.query(sql, [policy.id])).rowCount]);
  deleted.push([
    "stray Stripe webhook rows with no policy",
    (await client.query(`delete from "IntegrationEvent" where "policyId" is null and provider = 'stripe' and direction = 'INBOUND'`)).rowCount,
  ]);

  const remaining = await one(
    `select (select count(*) from "Policy")::int as policies, (select count(*) from "Customer")::int as customers,
            (select count(*) from "IntegrationEvent")::int as events`,
  );

  console.log(`\n${local ? "LOCAL" : "DEPLOYED"} database: policy ${policy.policyNumber} (${policy.businessName}, ${policy.status.toLowerCase()})\n`);
  console.table(Object.fromEntries(deleted.map(([label, count]) => [label, { rows: count }])));
  console.log(`Left afterwards: ${remaining.policies} policies, ${remaining.customers} customers, ${remaining.events} integration log rows.`);

  if (confirmation === expected) {
    await client.query("COMMIT");
    console.log("\nDeleted.");
  } else {
    await client.query("ROLLBACK");
    console.log(
      confirmation
        ? `\nNothing was deleted: the confirmation has to be exactly "${expected}".`
        : `\nNothing was deleted. This was a preview. To delete, run:\n\n  npm run clean:deployed --${local ? " --local" : ""} --confirm "${expected}"\n`,
    );
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  fail(`Nothing was deleted. ${error.message}`);
} finally {
  await client.end().catch(() => {});
}
