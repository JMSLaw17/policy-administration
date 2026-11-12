import "server-only";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { DEMO_PASSWORD } from "@/lib/demo";
import { addDays, todayISO, toJSDate, type ISODate } from "@/lib/engine";
import { isStripeConfigured, stripe } from "@/lib/integrations/stripe";
import { balanceCents, recordPaymentIntent, startPayment } from "./payments";
import { applyChange, issuePolicy } from "./service";

/**
 * Builds a fresh customer and policy in the state the brief describes:
 *
 *   "A customer has paid for their policy and an additional coverage change.
 *    Three weeks later, the broker discovers that the extra coverage began a
 *    week earlier than recorded."
 *
 * so the correction can be tried straight away, as often as wanted.
 *
 *   six weeks ago     policy issued with General Liability, and paid
 *   three weeks ago   Cyber Liability added, recorded as starting a week
 *                     later than it really did, and paid
 *   today             the broker spots the mistake
 *
 * Everything goes through the app's normal code: the same issue and coverage
 * change functions the screens use, and real Stripe test-mode payments, so a
 * correction that lowers the premium can refund to a real (test) card.
 *
 * Two things differ from a policy made by hand, and the policy page says so:
 *  - The application isn't signed through DocuSign.
 *  - The app's records are backdated. Stripe's own records show the payments
 *    as made at the moment the scenario was loaded.
 */

export class DemoScenarioError extends Error {}

/** Stripe's built-in test card that always succeeds. Works only in test mode. */
const TEST_CARD = "pm_card_visa";

export type DemoScenario = {
  customerId: string;
  policyId: string;
  /** The (wrong) date Cyber was recorded as starting. The right one is a week earlier. */
  recordedCyberStart: ISODate;
  actualCyberStart: ISODate;
};

export async function loadDemoScenario(brokerId: string): Promise<DemoScenario> {
  if (!isStripeConfigured()) {
    throw new DemoScenarioError("The demo scenario needs Stripe test keys, because it makes real test payments.");
  }

  const today = todayISO();
  const policyStart = addDays(today, -42);
  const cyberAddedOn = addDays(today, -21);
  const actualCyberStart = cyberAddedOn;
  const recordedCyberStart = addDays(actualCyberStart, 7);

  // A new fictional customer each time, with its own policyholder login.
  const tag = Math.random().toString(36).slice(2, 6);
  const email = `owner-${tag}@riverside-cafe.test`;
  const customer = await db.customer.create({
    data: {
      businessName: `Riverside Cafe LLC (demo ${tag})`,
      contactName: "Riley Rivers",
      email,
      addressLine1: "25 Mill Road",
      city: "Madison",
      state: "WI",
      postalCode: "53703",
      users: {
        create: {
          email,
          name: "Riley Rivers",
          role: "POLICYHOLDER",
          passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10),
        },
      },
    },
  });

  // Six weeks ago: issued and paid.
  const policy = await issuePolicy({
    customerId: customer.id,
    startDate: policyStart,
    coverageCodes: ["GL"],
    userId: brokerId,
  });
  await payByTestCard(policy.id);
  await backdate(policy.id, policyStart);

  // Three weeks ago: Cyber added with the wrong start date, and paid.
  await applyChange(
    policy.id,
    { kind: "COVERAGE_CHANGE", effectiveDate: recordedCyberStart, add: ["CYBER"], remove: [] },
    brokerId,
  );
  await payByTestCard(policy.id);
  await backdate(policy.id, cyberAddedOn);

  await db.policy.update({ where: { id: policy.id }, data: { demoLoadedAt: new Date() } });
  return { customerId: customer.id, policyId: policy.id, recordedCyberStart, actualCyberStart };
}

/** Pays the amount due the way a customer would, minus typing the card: Stripe confirms a test card. */
async function payByTestCard(policyId: string) {
  const { clientSecret } = await startPayment(policyId);
  const intentId = clientSecret.split("_secret_")[0];
  await stripe().paymentIntents.confirm(intentId, {
    payment_method: TEST_CARD,
    // Required by Stripe for payment methods that may redirect; a card never does.
    return_url: "https://example.com/not-used",
  });
  // The same step the webhook takes: read the payment back from Stripe and record it.
  await recordPaymentIntent(await stripe().paymentIntents.retrieve(intentId, { expand: ["payment_method"] }));
  if ((await balanceCents(policyId)) !== 0) {
    throw new DemoScenarioError("A demo payment didn't complete. Check the Stripe test keys.");
  }
}

/**
 * Moves everything recorded so far, that hasn't already been moved, to midday
 * on the given day. This is the one place records are re-dated, and only for
 * demo data in the moment it is created. Amounts are never touched.
 */
async function backdate(policyId: string, day: ISODate) {
  const at = new Date(toJSDate(day).getTime() + 17 * 3_600_000); // 17:00 UTC, midday in the US
  const recent = { gte: new Date(Date.now() - 10 * 60_000) };
  await db.$transaction([
    db.policyTransaction.updateMany({ where: { policyId, createdAt: recent }, data: { createdAt: at } }),
    db.ledgerEntry.updateMany({ where: { policyId, postedAt: recent }, data: { postedAt: at } }),
    db.payment.updateMany({ where: { policyId, createdAt: recent }, data: { createdAt: at } }),
    db.policy.updateMany({ where: { id: policyId, createdAt: recent }, data: { createdAt: at } }),
  ]);
}
