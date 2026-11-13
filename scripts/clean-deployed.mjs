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
 * To clear out everything a round of testing left behind, name the policies to
 * keep instead:
 *
 *   npm run clean:deployed -- --keep SBP-2026-0002,SBP-2026-0003
 *
 * That removes every other policy whole, a policy and its renewal together,
 * and then every customer left with no policy and no application, with their
 * login. A policy issued from a signed application is always kept, named or
 * not. It refuses if a policy to keep is tied by renewal to one that would go.
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
const keep = option("--keep")?.split(",").map((n) => n.trim()).filter(Boolean);
const expected = keep ? `delete all except ${keep.join(", ")}` : `delete ${policyNumber}`;

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

/** Everything attached to a policy, children first, so no row is left pointing at something that's gone. */
const ATTACHED = [
  ["statement lines", "LedgerEntry"],
  ["payments returned by the bank", "PaymentReturn"],
  ["refunds", "Refund"],
  ["payments", "Payment"],
  ["claims", "Claim"],
  ["integration log rows for these policies", "IntegrationEvent"],
  ["history entries", "PolicyTransaction"],
];

/** Removes every policy except the ones to keep, then the customers that leaves with nothing. */
async function cleanAllExcept(keepNumbers) {
  const policies = (
    await client.query(
      `select p.id, p."policyNumber", p."renewedFromId", c."businessName",
              exists (select 1 from "Application" a where a."policyId" = p.id) as signed
       from "Policy" p join "Customer" c on c.id = p."customerId" order by p."policyNumber" for update of p`,
    )
  ).rows;
  for (const number of keepNumbers) {
    if (!policies.some((p) => p.policyNumber === number)) fail(`No policy numbered ${number} to keep. Nothing was deleted.`);
  }
  const kept = policies.filter((p) => keepNumbers.includes(p.policyNumber) || p.signed);
  const going = policies.filter((p) => !kept.includes(p));
  const goingIds = new Set(going.map((p) => p.id));
  for (const p of policies) {
    const other = policies.find((o) => o.id === p.renewedFromId);
    if (other && goingIds.has(p.id) !== goingIds.has(other.id)) {
      fail(`${p.policyNumber} renews ${other.policyNumber}, and only one of them is being kept. Keep both or neither. Nothing was deleted.`);
    }
  }

  const ids = [...goingIds];
  const deleted = [];
  for (const [label, table] of ATTACHED) {
    deleted.push([label, (await client.query(`delete from "${table}" where "policyId" = any($1)`, [ids])).rowCount]);
  }
  // A renewal points at the policy it renews, so renewals go first.
  let policiesDeleted = 0;
  for (;;) {
    const { rowCount } = await client.query(
      `delete from "Policy" p where p.id = any($1) and not exists (select 1 from "Policy" r where r."renewedFromId" = p.id)`,
      [ids],
    );
    if (!rowCount) break;
    policiesDeleted += rowCount;
  }
  if (policiesDeleted !== ids.length) throw new Error("Some policies couldn't be removed.");
  deleted.push(["policies", policiesDeleted]);

  // Customers left with no policy and no application, and their logins.
  const empty = `select c.id from "Customer" c
                 where not exists (select 1 from "Policy" p where p."customerId" = c.id)
                   and not exists (select 1 from "Application" a where a."customerId" = c.id)`;
  deleted.push(["logins of customers left with no policy", (await client.query(`delete from "User" where "customerId" in (${empty})`)).rowCount]);
  const customers = await client.query(`delete from "Customer" where id in (${empty}) returning "businessName"`);
  deleted.push(["customers left with no policy", customers.rowCount]);
  deleted.push([
    "stray Stripe webhook rows with no policy",
    (await client.query(`delete from "IntegrationEvent" where "policyId" is null and provider = 'stripe' and direction = 'INBOUND'`)).rowCount,
  ]);

  console.log(`\n${local ? "LOCAL" : "DEPLOYED"} database\n`);
  console.log(`Kept (${kept.length}):`);
  for (const p of kept) console.log(`  ${p.policyNumber}  ${p.businessName}${p.signed ? "  (issued from a signed application)" : ""}`);
  console.log(`\nRemoved (${going.length}):`);
  for (const p of going) console.log(`  ${p.policyNumber}  ${p.businessName}`);
  console.log(`\nCustomers removed (${customers.rowCount}):`);
  for (const c of customers.rows) console.log(`  ${c.businessName}`);
  return deleted;
}

try {
  await client.query("BEGIN");

  if (keep) {
    const deleted = await cleanAllExcept(keep);
    const left = await one(
      `select (select count(*) from "Policy")::int as policies, (select count(*) from "Customer")::int as customers,
              (select count(*) from "IntegrationEvent")::int as events`,
    );
    console.log("");
    console.table(Object.fromEntries(deleted.map(([label, count]) => [label, { rows: count }])));
    console.log(`Left afterwards: ${left.policies} policies, ${left.customers} customers, ${left.events} integration log rows.`);
    if (confirmation === expected) {
      await client.query("COMMIT");
      console.log("\nDeleted.");
    } else {
      await client.query("ROLLBACK");
      console.log(
        confirmation
          ? `\nNothing was deleted: the confirmation has to be exactly "${expected}".`
          : `\nNothing was deleted. This was a preview. To delete, run:\n\n  npm run clean:deployed --${local ? " --local" : ""} --keep ${keep.join(",")} --confirm "${expected}"\n`,
      );
    }
    await client.end();
    process.exit(0);
  }

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
    ["payments returned by the bank", `delete from "PaymentReturn" where "policyId" = $1`],
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
