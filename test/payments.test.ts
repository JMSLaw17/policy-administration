import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { recordPaymentIntent, syncOpenPayments } from "@/lib/policies/payments";
import { applyChange, issuePolicy } from "@/lib/policies/service";
import { loadPolicyView } from "@/lib/policies/view";

/**
 * Tests of the payment and refund rules against a real (test) database, with
 * a stand-in for Stripe that remembers what it was asked to do. No network
 * calls are made.
 */

type FakeIntent = { id: string; status: string; amount: number; amount_received: number };

const fake = vi.hoisted(() => ({
  intents: new Map<string, { id: string; status: string; amount: number; amount_received: number }>(),
  refunds: [] as { id: string; amount: number; payment_intent: string }[],
}));

vi.mock("@/lib/integrations/stripe", () => ({
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
  isStripeConfigured: () => true,
  stripe: () => ({
    paymentIntents: {
      retrieve: async (id: string) => fake.intents.get(id)!,
      update: async (id: string, data: { amount: number }) => Object.assign(fake.intents.get(id)!, data),
      cancel: async (id: string) => Object.assign(fake.intents.get(id)!, { status: "canceled" }),
    },
    refunds: {
      create: async (data: { amount: number; payment_intent: string; metadata: Record<string, string> }) => {
        const refund = { id: `re_${fake.refunds.length + 1}`, status: "succeeded", ...data };
        fake.refunds.push(refund);
        return refund;
      },
    },
  }),
}));

let brokerId: string;
let customerId: string;

beforeAll(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Claim", "Application", "IntegrationEvent", "LedgerEntry", "Refund", "Payment", "PolicyTransaction", "Policy", "User", "Customer" RESTART IDENTITY CASCADE',
  );
  const customer = await db.customer.create({
    data: {
      businessName: "Test Bakery LLC",
      contactName: "Tess Tester",
      email: "tess@test-bakery.test",
      addressLine1: "1 Test Street",
      city: "Springfield",
      state: "IL",
      postalCode: "62701",
    },
  });
  customerId = customer.id;
  const broker = await db.user.create({
    data: { email: "broker@test.test", name: "Test Broker", role: "BROKER", passwordHash: "x" },
  });
  brokerId = broker.id;
});

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Claim", "IntegrationEvent", "LedgerEntry", "Refund", "Payment", "PolicyTransaction", "Policy" RESTART IDENTITY CASCADE',
  );
  fake.intents.clear();
  fake.refunds.length = 0;
});

const GL = 109_500; // General Liability for a full term
const CYBER_FROM_OCT_25 = 68_200; // 341 days at $2.00 a day
const WEEK_OF_CYBER = 1_400; // 7 days at $2.00 a day

/** A policy with General Liability, plus Cyber added from Oct 25. Returns the Cyber change. */
async function policyWithCyber() {
  const policy = await issuePolicy({ customerId, startDate: "2026-10-01", coverageCodes: ["GL"], userId: brokerId });
  const { transaction } = await applyChange(
    policy.id,
    { kind: "COVERAGE_CHANGE", effectiveDate: "2026-10-25", add: ["CYBER"], remove: [] },
    brokerId,
  );
  return { policyId: policy.id, cyberChangeId: transaction.id };
}

/** The broker corrects the date Cyber started. */
const moveCyberTo = (policyId: string, cyberChangeId: string, effectiveDate: string) =>
  applyChange(
    policyId,
    {
      kind: "CORRECTION",
      transactionId: cyberChangeId,
      event: { type: "COVERAGE_CHANGE", effectiveDate, add: ["CYBER"], remove: [] },
    },
    brokerId,
  );

/** A payment the customer has started with Stripe, in the given state. */
async function openPayment(policyId: string, intentStatus: string, status: "INITIATED" | "PENDING" | "FAILED" = "INITIATED") {
  const { balanceCents } = (await loadPolicyView(policyId))!;
  const intent: FakeIntent = { id: `pi_${fake.intents.size + 1}`, status: intentStatus, amount: balanceCents, amount_received: 0 };
  fake.intents.set(intent.id, intent);
  const payment = await db.payment.create({
    data: {
      policyId,
      amountCents: balanceCents,
      status,
      stripePaymentIntentId: intent.id,
      failureReason: status === "FAILED" ? "Your card was declined." : null,
    },
  });
  return { intent, paymentId: payment.id };
}

/** Stripe tells us the payment went through. */
async function stripeConfirms(intent: FakeIntent) {
  Object.assign(intent, { status: "succeeded", amount_received: intent.amount });
  await recordPaymentIntent(intent as unknown as Stripe.PaymentIntent);
}

const balance = async (policyId: string) => (await loadPolicyView(policyId))!.balanceCents;
const kinds = async (policyId: string) =>
  (await loadPolicyView(policyId))!.statement.map((r) => [r.kind, r.amountCents]).slice(-2);

describe("a payment that clears for more than is now due", () => {
  it("refunds the extra automatically, once", async () => {
    const { policyId, cyberChangeId } = await policyWithCyber();
    expect(await balance(policyId)).toBe(GL + CYBER_FROM_OCT_25);

    // A bank debit for the full amount is on its way and can't be changed.
    const { intent } = await openPayment(policyId, "processing", "PENDING");

    // Meanwhile the broker finds Cyber really started a week later, so less is due.
    await moveCyberTo(policyId, cyberChangeId, "2026-11-01");
    expect(await balance(policyId)).toBe(GL + CYBER_FROM_OCT_25 - WEEK_OF_CYBER);
    expect(fake.refunds).toHaveLength(0); // nothing has been paid yet, so nothing to refund

    // The debit clears for the old, higher amount. The extra week goes straight back.
    await stripeConfirms(intent);
    expect(fake.refunds).toMatchObject([{ amount: WEEK_OF_CYBER, payment_intent: intent.id }]);
    expect(await kinds(policyId)).toEqual([
      ["PAYMENT", -(GL + CYBER_FROM_OCT_25)],
      ["REFUND", WEEK_OF_CYBER],
    ]);
    expect((await loadPolicyView(policyId))!.totals).toEqual({
      premiumCents: GL + CYBER_FROM_OCT_25 - WEEK_OF_CYBER,
      paidCents: GL + CYBER_FROM_OCT_25,
      refundedCents: WEEK_OF_CYBER,
    });
    expect(await balance(policyId)).toBe(0);

    // Hearing about the same payment again changes nothing.
    await stripeConfirms(intent);
    expect(fake.refunds).toHaveLength(1);
    expect(await balance(policyId)).toBe(0);
  });

  it("refunds nothing when the payment matches what is due", async () => {
    const { policyId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    expect(fake.refunds).toHaveLength(0);
    expect(await balance(policyId)).toBe(0);
  });
});

describe("a payment form left open while the broker changes the policy", () => {
  it("is lowered when less is due", async () => {
    const { policyId, cyberChangeId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "requires_payment_method");

    await moveCyberTo(policyId, cyberChangeId, "2026-11-01");
    await syncOpenPayments(policyId);

    const due = GL + CYBER_FROM_OCT_25 - WEEK_OF_CYBER;
    expect(intent.amount).toBe(due);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).amountCents).toBe(due);

    // Paying it now settles the policy exactly, with nothing to refund.
    await stripeConfirms(intent);
    expect(await balance(policyId)).toBe(0);
    expect(fake.refunds).toHaveLength(0);
  });

  it("is lowered even after a declined card, because the form can still be retried", async () => {
    const { policyId, cyberChangeId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "requires_payment_method", "FAILED");

    await moveCyberTo(policyId, cyberChangeId, "2026-11-01");
    await syncOpenPayments(policyId);
    expect(intent.amount).toBe(GL + CYBER_FROM_OCT_25 - WEEK_OF_CYBER);
  });

  it("is never raised: the customer pays what their screen showed and the rest stays due", async () => {
    const { policyId, cyberChangeId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "requires_payment_method");

    await moveCyberTo(policyId, cyberChangeId, "2026-10-18");
    await syncOpenPayments(policyId);
    expect(intent.amount).toBe(GL + CYBER_FROM_OCT_25);

    await stripeConfirms(intent);
    expect(await balance(policyId)).toBe(WEEK_OF_CYBER);
    // The week still owed is explained by the correction, though the payment came after it.
    expect((await loadPolicyView(policyId))!.dueBecause.map((r) => [r.title, r.netCents])).toEqual([
      ["Correction to #2", WEEK_OF_CYBER],
    ]);
  });

  it("is cancelled when nothing is due any more", async () => {
    const { policyId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "requires_payment_method");

    // Cancelling from the first day leaves nothing owed.
    await applyChange(policyId, { kind: "CANCELLATION", effectiveDate: "2026-10-01" }, brokerId);
    expect(await balance(policyId)).toBe(0);
    await syncOpenPayments(policyId);

    expect(intent.status).toBe("canceled");
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("FAILED");
  });
});
