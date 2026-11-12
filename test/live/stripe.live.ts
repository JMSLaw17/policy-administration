import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { stripe } from "@/lib/integrations/stripe";
import {
  balanceCents,
  PaymentError,
  recordPaymentIntent,
  refundCredit,
  startPayment,
} from "@/lib/policies/payments";
import { applyChange, issuePolicy } from "@/lib/policies/service";
import { loadPolicyView } from "@/lib/policies/view";

/**
 * The app's real payment and refund code against the real Stripe test mode.
 *
 * The only thing replaced is the customer typing a card into Stripe's form:
 * here the payment is completed through Stripe's API with Stripe's built-in
 * test payment methods. Everything after that is what runs in production.
 * Nothing here can move real money; the Stripe client refuses live keys.
 *
 * Stripe's webhook can't reach a test run, so each test tells the app to
 * look the payment up, which is the same code the webhook handler runs.
 */

const VISA = "pm_card_visa";
const DECLINED = "pm_card_chargeDeclined";
const BANK = "pm_usBankAccount_success";

let brokerId: string;
let customerId: string;

beforeAll(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Claim", "Application", "IntegrationEvent", "LedgerEntry", "Refund", "Payment", "PolicyTransaction", "Policy", "User", "Customer" RESTART IDENTITY CASCADE',
  );
  const customer = await db.customer.create({
    data: {
      businessName: "Live Test Bakery LLC",
      contactName: "Tess Tester",
      email: "tess@live-test-bakery.test",
      addressLine1: "1 Test Street",
      city: "Springfield",
      state: "IL",
      postalCode: "62701",
    },
  });
  customerId = customer.id;
  brokerId = (
    await db.user.create({
      data: { email: "broker@live.test", name: "Test Broker", role: "BROKER", passwordHash: "x" },
    })
  ).id;
});

/** Stands in for the customer completing Stripe's payment form. */
async function payWith(policyId: string, paymentMethod: string) {
  const { clientSecret, amountCents } = await startPayment(policyId);
  const intentId = clientSecret.split("_secret_")[0];
  try {
    await stripe().paymentIntents.confirm(intentId, {
      payment_method: paymentMethod,
      return_url: "http://localhost:3100/portal",
      ...(paymentMethod === BANK && {
        mandate_data: {
          customer_acceptance: { type: "online", online: { ip_address: "127.0.0.1", user_agent: "test" } },
        },
      }),
    });
  } catch (error) {
    // A declined card makes Stripe's API throw. The decline is recorded below.
    if ((error as { code?: string }).code !== "card_declined") throw error;
  }
  // What the webhook handler does when Stripe calls: re-read the payment and record it.
  await recordPaymentIntent(await stripe().paymentIntents.retrieve(intentId, { expand: ["payment_method"] }));
  return { intentId, amountCents };
}

const view = async (policyId: string) => (await loadPolicyView(policyId))!;

describe("Stripe test mode, end to end", () => {
  it("records a declined card as failed and leaves the amount due unchanged", async () => {
    const policy = await issuePolicy({ customerId, startDate: "2026-10-01", coverageCodes: ["GL"], userId: brokerId });
    const { intentId } = await payWith(policy.id, DECLINED);

    const v = await view(policy.id);
    expect(v.balanceCents).toBe(109_500);
    expect(v.payments).toHaveLength(1);
    expect(v.payments[0]).toMatchObject({ status: "FAILED", failureReason: "Your card was declined.", statementLine: null });

    // Trying again starts a fresh payment and cancels the failed one at Stripe,
    // so the old attempt can never complete on top of the new one.
    const second = await payWith(policy.id, VISA);
    expect(second.intentId).not.toBe(intentId);
    expect((await stripe().paymentIntents.retrieve(intentId)).status).toBe("canceled");

    const after = await view(policy.id);
    expect(after.balanceCents).toBe(0);
    expect(after.payments.map((p) => p.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(after.statement.at(-1)).toMatchObject({
      kind: "PAYMENT",
      amountCents: -109_500,
      description: "Payment received (card ending 4242)",
    });
    await expect(startPayment(policy.id)).rejects.toThrow("Nothing is due");
  });

  it("posts a payment once, however many times Stripe reports it", async () => {
    const policy = await issuePolicy({ customerId, startDate: "2026-10-01", coverageCodes: ["GL"], userId: brokerId });
    const { intentId } = await payWith(policy.id, VISA);
    const intent = await stripe().paymentIntents.retrieve(intentId, { expand: ["payment_method"] });
    await Promise.all([recordPaymentIntent(intent), recordPaymentIntent(intent), recordPaymentIntent(intent)]);
    expect((await view(policy.id)).statement.filter((r) => r.kind === "PAYMENT")).toHaveLength(1);
    expect(await balanceCents(policy.id)).toBe(0);
  });

  it("refunds a correction's credit, then a cancellation's, back to the cards", async () => {
    // The reviewers' scenario with real payments: policy paid, Cyber added and paid.
    const policy = await issuePolicy({ customerId, startDate: "2026-10-01", coverageCodes: ["GL"], userId: brokerId });
    await payWith(policy.id, VISA);
    const change = await applyChange(
      policy.id,
      { kind: "COVERAGE_CHANGE", effectiveDate: "2026-11-01", add: ["CYBER"], remove: [] },
      brokerId,
    );
    const cyberPayment = await payWith(policy.id, VISA);
    expect(cyberPayment.amountCents).toBe(66_800);

    // Correct the date a week EARLIER: $14.00 more is due, and nothing is refunded.
    const correct = (effectiveDate: string) =>
      applyChange(
        policy.id,
        {
          kind: "CORRECTION",
          transactionId: change.transaction.id,
          event: { type: "COVERAGE_CHANGE", effectiveDate, add: ["CYBER"], remove: [] },
        },
        brokerId,
      );
    const earlier = await correct("2026-10-25");
    expect(await refundCredit(policy.id, earlier.transaction.id)).toMatchObject({ refundedCents: 0 });
    expect(await balanceCents(policy.id)).toBe(1_400);

    // Now a week LATER than first recorded: the customer is owed $14.00 back.
    const later = await correct("2026-11-08");
    expect(await balanceCents(policy.id)).toBe(-1_400);
    expect(await refundCredit(policy.id, later.transaction.id)).toMatchObject({ refundedCents: 1_400 });

    let v = await view(policy.id);
    expect(v.balanceCents).toBe(0);
    expect(v.refunds).toHaveLength(1);
    expect(v.refunds[0]).toMatchObject({ status: "SUCCEEDED", amountCents: 1_400 });
    expect(v.statement.at(-1)).toMatchObject({ kind: "REFUND", amountCents: 1_400 });
    // Stripe agrees, and the refund came off the newest payment.
    const stripeRefund = await stripe().refunds.retrieve(v.refunds[0].stripeRefundId!);
    expect(stripeRefund).toMatchObject({ status: "succeeded", amount: 1_400, payment_intent: cyberPayment.intentId });

    // Cancel from Apr 1: $549.00 + $366.00 of unused premium goes back, split across both payments.
    const cancel = await applyChange(policy.id, { kind: "CANCELLATION", effectiveDate: "2027-04-01" }, brokerId);
    expect(await refundCredit(policy.id, cancel.transaction.id)).toMatchObject({ refundedCents: 91_500 });

    v = await view(policy.id);
    expect(v.balanceCents).toBe(0);
    expect(v.status).toBe("CANCELLED");
    expect(v.refunds.every((r) => r.status === "SUCCEEDED")).toBe(true);
    // Newest payment first: the rest of the $668.00 Cyber payment, then the remainder from the first.
    expect(v.refunds.map((r) => r.amountCents)).toEqual([1_400, 65_400, 26_100]);
    // Running it again finds nothing left to refund.
    expect(await refundCredit(policy.id)).toMatchObject({ refundedCents: 0 });

    // Every payment and refund left a trail in the integration log.
    const events = await db.integrationEvent.groupBy({
      by: ["eventType"],
      where: { policyId: policy.id },
      _count: true,
    });
    expect(Object.fromEntries(events.map((e) => [e.eventType, e._count]))).toMatchObject({
      "payment_intent.create": 2,
      "refund.create": 3,
    });
  });

  it("shows a bank payment as pending until it clears, and blocks a second payment meanwhile", async () => {
    const policy = await issuePolicy({ customerId, startDate: "2026-10-01", coverageCodes: ["GL"], userId: brokerId });
    await payWith(policy.id, BANK);

    const v = await view(policy.id);
    expect(v.payments[0]).toMatchObject({ status: "PENDING", statementLine: null });
    // Not on the statement yet, so the amount is still due.
    expect(v.balanceCents).toBe(109_500);
    await expect(startPayment(policy.id)).rejects.toThrow(PaymentError);
    await expect(startPayment(policy.id)).rejects.toThrow(/already being processed/);
  });
});
