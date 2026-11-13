#!/usr/bin/env node
/**
 * Collects evidence that the two sandbox integrations are live, straight from
 * the sandboxes' own records and from the deployed app's database:
 *
 *   docs/evidence/stripe.md      Stripe test-mode events, webhook endpoint, refunds
 *   docs/evidence/docusign.md    DocuSign sandbox envelopes, audit trails, webhook deliveries
 *   docs/evidence/deployed-app.md  what the deployed app itself recorded
 *
 * Run with `npm run evidence`. It only reads. Keys come from .env and the
 * deployed database's address from .env.production.local; none are written out.
 */
import { execFileSync } from "node:child_process";
import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Stripe from "stripe";

process.loadEnvFile(".env");
mkdirSync("docs/evidence", { recursive: true });

const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
const utc = (seconds) => new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const table = (headers, rows) =>
  [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
/** Shows enough of an id to match it against a dashboard, without publishing all of it. */
const short = (id) => (id ? `${id.slice(0, 12)}…` : "");

/* ------------------------------- Stripe ------------------------------- */

/** Policies on the deployed app, by id. Null if we can't read its database. */
function deployedPolicies() {
  if (!existsSync(".env.production.local")) return null;
  const rows = JSON.parse(
    execFileSync("node", ["scripts/prod-query.mjs", "--json", 'select id, "policyNumber" from "Policy"'], { encoding: "utf8" }),
  );
  return new Map(rows.map((r) => [r.id, r.policyNumber]));
}

/** The deployed app's Stripe payments, by PaymentIntent id. A dispute names its payment, not its policy. */
function deployedPayments() {
  if (!existsSync(".env.production.local")) return new Map();
  const rows = JSON.parse(
    execFileSync(
      "node",
      [
        "scripts/prod-query.mjs",
        "--json",
        'select pay."stripePaymentIntentId" as intent, p.id as "policyId" from "Payment" pay join "Policy" p on p.id = pay."policyId" where pay."stripePaymentIntentId" is not null',
      ],
      { encoding: "utf8" },
    ),
  );
  return new Map(rows.map((r) => [r.intent, r.policyId]));
}

async function stripeEvidence() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key?.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY must be a test key");
  const stripe = new Stripe(key);

  const endpoints = await stripe.webhookEndpoints.list();
  const events = [];
  for await (const e of stripe.events.list({ limit: 100, types: [
    "payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.processing",
    "payment_intent.canceled", "refund.created", "refund.updated", "refund.failed",
    "charge.dispute.created", "charge.dispute.funds_withdrawn", "charge.dispute.closed",
  ] })) {
    // Every event Stripe still holds (it keeps 30 days), not just the newest few hundred:
    // local and automated testing on the same account would otherwise push the deployed
    // app's events off the end.
    events.push(e);
    if (events.length >= 20_000) break;
  }
  const allRefunds = { data: [] };
  for await (const r of stripe.refunds.list({ limit: 100 })) {
    allRefunds.data.push(r);
    if (allRefunds.data.length >= 5_000) break;
  }

  // One Stripe test account serves the deployed app, local development, and
  // the automated tests. Keep only what belongs to the deployed app, matched
  // by the policy id the app attaches to every payment and refund.
  const policies = deployedPolicies();
  const payments = deployedPayments();
  // A payment or refund carries the policy id. A dispute carries only its payment.
  const policyIdOf = (o) => o.metadata?.policyId ?? payments.get(typeof o.payment_intent === "string" ? o.payment_intent : "");
  const mine = (o) => !policies || policies.has(policyIdOf(o));
  const policyOf = (o) => policies?.get(policyIdOf(o)) ?? o.metadata?.policyNumber ?? "";
  const total = events.length;
  const kept = events.filter((e) => mine(e.data.object));
  const refunds = { data: allRefunds.data.filter(mine) };

  const out = [
    "# Stripe evidence (test mode)",
    "",
    `Collected ${now} from Stripe's API with a test-mode key. Nothing here involves real money.`,
    "",
    "## Webhook endpoint",
    "",
    table(
      ["Address", "Status", "Events subscribed"],
      endpoints.data.map((w) => [w.url, w.status, w.enabled_events.join(", ")]),
    ),
    "",
    "## Events Stripe sent to the webhook",
    "",
    "Newest first. \"Waiting\" is how many webhook deliveries Stripe still has outstanding for that event; 0 means the app acknowledged it.",
    policies
      ? `One Stripe test account serves the deployed app, local development, and the automated tests. This list shows the ${kept.length} events for policies on the deployed app, out of the ${total} most recent; the rest came from local and automated testing.`
      : "The deployed database wasn't available, so this list includes events from local and automated testing as well.",
    "",
    table(
      ["Time (UTC)", "Event", "Object", "Amount", "Status", "Policy", "Waiting"],
      kept.map((e) => {
        const o = e.data.object;
        return [utc(e.created), `\`${e.type}\``, `\`${short(o.id)}\``, usd(o.amount ?? 0), o.status ?? "", policyOf(o), e.pending_webhooks];
      }),
    ),
    "",
    "## Refunds",
    "",
    table(
      ["Time (UTC)", "Refund", "Amount", "Status", "Policy", "Against payment"],
      refunds.data.map((r) => [utc(r.created), `\`${short(r.id)}\``, usd(r.amount), r.status, policyOf(r), `\`${short(String(r.payment_intent ?? ""))}\``]),
    ),
    "",
  ].join("\n");
  writeFileSync("docs/evidence/stripe.md", out);
  return `${kept.length} of ${total} events, ${refunds.data.length} refunds`;
}

/* ------------------------------ DocuSign ------------------------------ */

async function docusignEvidence() {
  const pem = process.env.DOCUSIGN_PRIVATE_KEY_BASE64
    ? Buffer.from(process.env.DOCUSIGN_PRIVATE_KEY_BASE64, "base64").toString("utf8")
    : existsSync("docusign_private.pem") && readFileSync("docusign_private.pem", "utf8");
  if (!pem) throw new Error("No DocuSign key found");
  const b64 = (x) => Buffer.from(x).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64(JSON.stringify({
    iss: process.env.DOCUSIGN_INTEGRATION_KEY, sub: process.env.DOCUSIGN_USER_ID,
    aud: "account-d.docusign.com", iat, exp: iat + 600, scope: "signature impersonation",
  }));
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(createPrivateKey(pem));
  const token = await (await fetch("https://account-d.docusign.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${body}.${b64(signature)}` }),
  })).json();
  if (!token.access_token) throw new Error(`DocuSign sign-in failed: ${token.error}`);

  // "demo.docusign.net" is DocuSign's sandbox.
  const base = `https://demo.docusign.net/restapi/v2.1/accounts/${process.env.DOCUSIGN_ACCOUNT_ID}`;
  const get = async (path) => (await fetch(base + path, { headers: { authorization: `Bearer ${token.access_token}` } })).json();

  const from = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const list = await get(`/envelopes?from_date=${encodeURIComponent(from)}&include=recipients&order=desc`);
  const envelopes = list.envelopes ?? [];
  const sections = [];
  for (const e of envelopes) {
    const audit = await get(`/envelopes/${e.envelopeId}/audit_events`);
    const steps = (audit.auditEvents ?? []).map((a) => {
      const f = Object.fromEntries(a.eventFields.map((x) => [x.name, x.value]));
      return [f.logTime?.replace("T", " ").slice(0, 19), f.Action, f.EnvelopeStatus ?? ""];
    });
    sections.push(
      `### Envelope \`${short(e.envelopeId)}\`: ${e.status}`,
      "",
      `"${e.emailSubject}", signer ${e.recipients?.signers?.[0]?.name ?? ""}. Sent ${e.sentDateTime?.replace("T", " ").slice(0, 19)} UTC, completed ${e.completedDateTime?.replace("T", " ").slice(0, 19) ?? "not yet"} UTC.`,
      "",
      table(["Time (UTC)", "Action", "Envelope status"], steps),
      "",
    );
  }

  const logs = await get("/connect/logs");
  const failures = await get("/connect/failures");
  const deliveries = [];
  for (const l of logs.logs ?? []) {
    const detail = await get(`/connect/logs/${l.logId}?additional_info=true`);
    const lines = (detail.connectDebugLog ?? []).map((d) => d.eventDescription ?? "");
    const sent = lines.find((x) => x.startsWith("Envelope Data:"));
    const reply = lines.find((x) => x.startsWith("Response:"));
    const path = lines.find((x) => x.includes("X-Matched-Path"))?.match(/X-Matched-Path: (\S+)/)?.[1] ?? "";
    deliveries.push([
      l.created?.replace("T", " ").slice(0, 19), `\`${short(l.envelopeId)}\``,
      sent ? `\`${JSON.parse(sent.slice("Envelope Data:".length)).event}\`` : "", path, reply ? `\`${reply.slice("Response: ".length)}\`` : "",
    ]);
  }

  writeFileSync("docs/evidence/docusign.md", [
    "# DocuSign evidence (developer sandbox)",
    "",
    `Collected ${now} from DocuSign's API on its sandbox host, demo.docusign.net. Documents signed there are watermarked and not legally binding.`,
    "",
    "## Envelopes",
    "",
    "Each application the app sent for signature, with DocuSign's own audit trail. \"Viewed In-Session\" means the signer signed inside the app (embedded signing), not from an emailed link.",
    "",
    ...sections,
    "## Webhook deliveries (DocuSign Connect)",
    "",
    `What DocuSign sent to the deployed app when an envelope was completed, and the app's reply. Failed deliveries on record: ${failures.totalRecords ?? "0"}.`,
    "",
    table(["Time (UTC)", "Envelope", "Event", "Delivered to", "App's reply"], deliveries),
    "",
    "DocuSign can't reach a developer's laptop, so envelopes signed against a local copy of the app have no delivery here.",
    "",
  ].join("\n"));
  return `${envelopes.length} envelopes, ${deliveries.length} webhook deliveries`;
}

/* --------------------------- The deployed app --------------------------- */

function deployedEvidence() {
  if (!existsSync(".env.production.local")) return "skipped (no .env.production.local)";
  const rows = (sql) => JSON.parse(execFileSync("node", ["scripts/prod-query.mjs", "--json", sql], { encoding: "utf8" }));
  const asTable = (sql) => {
    const r = rows(sql);
    return r.length ? table(Object.keys(r[0]), r.map((row) => Object.values(row).map((v) => v ?? ""))) : "None.";
  };
  const events = rows(`select to_char(e."createdAt", 'YYYY-MM-DD HH24:MI:SS') as "Time (UTC)", e.provider as "Service", case when e.direction = 'INBOUND' then 'Received' else 'Sent' end as "Direction", e."eventType" as "Event", left(coalesce(e."externalId", ''), 12) as "Reference", coalesce(p."policyNumber", '') as "Policy" from "IntegrationEvent" e left join "Policy" p on p.id = e."policyId" order by e."createdAt"`);
  const strays = events.filter((e) => e.Service === "stripe" && e.Direction === "Received" && !e.Policy).length;

  writeFileSync("docs/evidence/deployed-app.md", [
    "# What the deployed app recorded",
    "",
    `Read ${now} from the deployed app's database (read-only). These are the app's own records of its sandbox activity: the same rows the broker's Integration log page shows.`,
    "",
    "## Integration log: every sandbox request sent and webhook received",
    "",
    '"Sent" is a request the app made to a sandbox. "Received" is a webhook the sandbox delivered to the app.',
    ...(strays
      ? [
          "",
          `${strays} received Stripe rows have no policy. They are payments made by local and automated tests on the same Stripe test account, delivered here because Stripe sends every event to this address. The app took no action on them, and has since been changed to leave such events out of the log.`,
        ]
      : []),
    "",
    table(Object.keys(events[0] ?? { "": "" }), events.map((e) => Object.values(e))),
    "",
    "## Payments and refunds, with their Stripe references",
    "",
    asTable(`select * from (select to_char(p."createdAt", 'YYYY-MM-DD HH24:MI:SS') as "Time (UTC)", 'Payment' as "Kind", initcap(p.status::text) as "Status", '$' || to_char(p."amountCents" / 100.0, 'FM999,990.00') as "Amount", pol."policyNumber" as "Policy", left(coalesce(p."stripePaymentIntentId", ''), 12) as "Stripe reference" from "Payment" p join "Policy" pol on pol.id = p."policyId" union all select to_char(r."createdAt", 'YYYY-MM-DD HH24:MI:SS'), 'Refund', initcap(r.status::text), '$' || to_char(r."amountCents" / 100.0, 'FM999,990.00'), pol."policyNumber", left(coalesce(r."stripeRefundId", ''), 12) from "Refund" r join "Policy" pol on pol.id = r."policyId") t order by 1`),
    "",
    "## Signed applications, with their DocuSign envelopes",
    "",
    asTable(`select initcap(a.status::text) as "Status", left(a."docusignEnvelopeId", 12) as "Envelope", a."signerName" as "Signer", to_char(a."signedAt", 'YYYY-MM-DD HH24:MI:SS') as "Signed (UTC)", p."policyNumber" as "Policy issued" from "Application" a left join "Policy" p on p.id = a."policyId" order by a."createdAt"`),
    "",
    "## Claims",
    "",
    asTable(`select c."claimNumber" as "Claim", initcap(c.status::text) as "Status", '$' || to_char(c."claimedCents" / 100.0, 'FM999,990.00') as "Claimed", coalesce('$' || to_char(c."payoutCents" / 100.0, 'FM999,990.00'), '') as "Paid out", p."policyNumber" as "Policy" from "Claim" c join "Policy" p on p.id = c."policyId" order by c."filedAt"`),
    "",
    "Claim payments are simulated: they are recorded in the app and no money moves.",
    "",
  ].join("\n"));
  return `${events.length} integration events`;
}

for (const [name, run] of [["Stripe", stripeEvidence], ["DocuSign", docusignEvidence], ["Deployed app", deployedEvidence]]) {
  try {
    console.log(`${name}: ${await run()}`);
  } catch (error) {
    console.error(`${name}: failed, ${error.message}`);
    process.exitCode = 1;
  }
}
