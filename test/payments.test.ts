import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import {
  reconcilePending,
  recordDispute,
  recordPaymentIntent,
  recordRefund,
  refundCredit,
  startPayment,
  syncOpenPayments,
} from "@/lib/policies/payments";
import { applyChange, issuePolicy } from "@/lib/policies/service";
import { loadPolicyView } from "@/lib/policies/view";

/**
 * Tests of the payment and refund rules against a real (test) database, with
 * a stand-in for Stripe that remembers what it was asked to do. No network
 * calls are made.
 */

type FakeIntent = { id: string; status: string; amount: number; amount_received: number };

type FakeRefund = { id: string; status: string; amount: number; payment_intent: string; metadata: Record<string, string> };

const fake = vi.hoisted(() => ({
  intents: new Map<string, { id: string; status: string; amount: number; amount_received: number }>(),
  refunds: [] as { id: string; status: string; amount: number; payment_intent: string; metadata: Record<string, string> }[],
  /** What Stripe remembers for each idempotency key, as the real one does for 24 hours. */
  byKey: new Map<string, unknown>(),
  /**
   * How the next refund request goes wrong, if at all:
   *  - "lost": Stripe makes the refund, but the answer never reaches us.
   *  - "rejected": Stripe refuses, and makes nothing.
   */
  refundFault: null as null | "lost" | "rejected",
  /** The state Stripe reports for a new refund. A bank refund starts as "pending". */
  refundStatus: "succeeded",
}));

vi.mock("@/lib/integrations/stripe", async () => {
  const { default: Stripe } = await vi.importActual<typeof import("stripe")>("stripe");
  return {
    StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
    isStripeConfigured: () => true,
    stripe: () => ({
      paymentIntents: {
        create: async (data: { amount: number }, options: { idempotencyKey: string }) => {
          const seen = fake.byKey.get(options.idempotencyKey);
          if (seen) return seen;
          const id = `pi_${fake.intents.size + 1}`;
          const intent = { id, status: "requires_payment_method", amount: data.amount, amount_received: 0, client_secret: `${id}_secret` };
          fake.intents.set(id, intent);
          fake.byKey.set(options.idempotencyKey, intent);
          return intent;
        },
        retrieve: async (id: string) => fake.intents.get(id)!,
        update: async (id: string, data: { amount: number }) => Object.assign(fake.intents.get(id)!, data),
        cancel: async (id: string) => Object.assign(fake.intents.get(id)!, { status: "canceled" }),
      },
      refunds: {
        create: async (data: Omit<FakeRefund, "id" | "status">, options: { idempotencyKey: string }) => {
          const seen = fake.byKey.get(options.idempotencyKey);
          if (seen) return seen;
          const fault = fake.refundFault;
          fake.refundFault = null;
          if (fault === "rejected") {
            throw new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "This payment can't be refunded." });
          }
          const refund = { id: `re_${fake.refunds.length + 1}`, status: fake.refundStatus, ...data };
          fake.refunds.push(refund);
          fake.byKey.set(options.idempotencyKey, refund);
          if (fault === "lost") {
            throw new Stripe.errors.StripeConnectionError({ type: "api_error", message: "The connection to Stripe was lost." });
          }
          return refund;
        },
        list: async (query: { payment_intent: string }) => ({
          data: fake.refunds.filter((r) => r.payment_intent === query.payment_intent),
        }),
        retrieve: async (id: string) => fake.refunds.find((r) => r.id === id)!,
      },
    }),
  };
});

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
  fake.byKey.clear();
  fake.refundFault = null;
  fake.refundStatus = "succeeded";
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

describe("starting a payment", () => {
  it("gives two checkouts opened at the same moment one attempt and one Stripe payment", async () => {
    const { policyId } = await policyWithCyber();
    const [first, second] = await Promise.all([startPayment(policyId), startPayment(policyId)]);

    expect(first).toEqual({ clientSecret: "pi_1_secret", amountCents: GL + CYBER_FROM_OCT_25 });
    expect(second).toEqual(first);
    expect(fake.intents.size).toBe(1);
    expect(await db.payment.count({ where: { policyId } })).toBe(1);

    // Opening the form again later still reuses it, and one payment settles the policy.
    expect(await startPayment(policyId)).toEqual(first);
    await stripeConfirms(fake.intents.get("pi_1")!);
    expect(await balance(policyId)).toBe(0);
    expect(await db.payment.count({ where: { policyId } })).toBe(1);
  });

  it("picks up an attempt that was reserved but never reached Stripe", async () => {
    const { policyId } = await policyWithCyber();
    // The process stopped between reserving the attempt and asking Stripe for it.
    const reserved = await db.payment.create({ data: { policyId, amountCents: GL + CYBER_FROM_OCT_25 } });

    const started = await startPayment(policyId);
    expect(started.amountCents).toBe(GL + CYBER_FROM_OCT_25);
    expect(await db.payment.findMany({ where: { policyId } })).toMatchObject([
      { id: reserved.id, status: "INITIATED", stripePaymentIntentId: "pi_1" },
    ]);
  });

  it("never raises an amount already offered: when more is due it starts a new payment", async () => {
    const { policyId, cyberChangeId } = await policyWithCyber();
    const first = await startPayment(policyId);
    expect(first.amountCents).toBe(GL + CYBER_FROM_OCT_25);

    // More becomes due. A form that is open in another tab still says the old amount,
    // so that payment is closed, not raised, and can no longer be completed.
    await moveCyberTo(policyId, cyberChangeId, "2026-10-18");
    const reopened = await startPayment(policyId);
    expect(reopened).toEqual({ clientSecret: "pi_2_secret", amountCents: GL + CYBER_FROM_OCT_25 + WEEK_OF_CYBER });
    expect(fake.intents.get("pi_1")).toMatchObject({ status: "canceled", amount: GL + CYBER_FROM_OCT_25 });
    expect(
      await db.payment.findMany({ where: { policyId }, orderBy: { createdAt: "asc" }, select: { status: true, amountCents: true } }),
    ).toEqual([
      { status: "FAILED", amountCents: GL + CYBER_FROM_OCT_25 },
      { status: "INITIATED", amountCents: GL + CYBER_FROM_OCT_25 + WEEK_OF_CYBER },
    ]);
  });

  it("lowers the open payment when less is due, and reports the amount it will collect", async () => {
    const { policyId, cyberChangeId } = await policyWithCyber();
    await startPayment(policyId);
    await moveCyberTo(policyId, cyberChangeId, "2026-11-01");
    const reopened = await startPayment(policyId);
    expect(reopened).toEqual({ clientSecret: "pi_1_secret", amountCents: GL + CYBER_FROM_OCT_25 - WEEK_OF_CYBER });
    expect(fake.intents.get("pi_1")!.amount).toBe(reopened.amountCents);
  });
});

describe("a refund that is interrupted", () => {
  /** A paid-up policy that is then owed a week of Cyber back. */
  async function policyOwedARefund() {
    const { policyId, cyberChangeId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    await moveCyberTo(policyId, cyberChangeId, "2026-11-01");
    expect(await balance(policyId)).toBe(-WEEK_OF_CYBER);
    return policyId;
  }
  const refundRows = (policyId: string) =>
    db.refund.findMany({ where: { policyId }, orderBy: { createdAt: "asc" }, select: { status: true, stripeRefundId: true, amountCents: true } });

  it("is not sent twice when Stripe made the refund but its answer was lost", async () => {
    const policyId = await policyOwedARefund();
    fake.refundFault = "lost";
    const first = await refundCredit(policyId);
    expect(first.message).toMatch(/couldn't be confirmed with Stripe yet/);

    // Stripe has the refund. We don't know that yet, so the row waits, still holding the credit.
    expect(fake.refunds).toHaveLength(1);
    expect(await refundRows(policyId)).toEqual([{ status: "PENDING", stripeRefundId: null, amountCents: WEEK_OF_CYBER }]);

    // Retrying resumes the same refund. Stripe is not asked for a second one.
    expect(await refundCredit(policyId)).toMatchObject({ refundedCents: WEEK_OF_CYBER });
    expect(fake.refunds).toHaveLength(1);
    expect(await refundRows(policyId)).toEqual([{ status: "SUCCEEDED", stripeRefundId: "re_1", amountCents: WEEK_OF_CYBER }]);
    expect(await balance(policyId)).toBe(0);

    // And once more changes nothing.
    expect(await refundCredit(policyId)).toMatchObject({ refundedCents: 0 });
    expect(fake.refunds).toHaveLength(1);
  });

  it("is found again after Stripe has forgotten the idempotency key", async () => {
    const policyId = await policyOwedARefund();
    fake.refundFault = "lost";
    await refundCredit(policyId);
    fake.byKey.clear(); // more than 24 hours pass

    // Opening the policy checks with Stripe, which already has the refund under our reference.
    await reconcilePending(policyId);
    expect(fake.refunds).toHaveLength(1);
    expect(await refundRows(policyId)).toEqual([{ status: "SUCCEEDED", stripeRefundId: "re_1", amountCents: WEEK_OF_CYBER }]);
    expect(await balance(policyId)).toBe(0);
  });

  it("is sent when the app stopped before Stripe was asked", async () => {
    const policyId = await policyOwedARefund();
    // The refund was decided and saved, and then the process stopped.
    const payment = await db.payment.findFirstOrThrow({ where: { policyId, status: "SUCCEEDED" } });
    await db.refund.create({ data: { policyId, paymentId: payment.id, amountCents: WEEK_OF_CYBER, status: "PENDING" } });

    // It holds the credit, so a new refund isn't planned on top of it...
    // ...and opening the policy sends it, once.
    await reconcilePending(policyId);
    await reconcilePending(policyId);
    expect(fake.refunds).toMatchObject([{ amount: WEEK_OF_CYBER }]);
    expect(await refundRows(policyId)).toEqual([{ status: "SUCCEEDED", stripeRefundId: "re_1", amountCents: WEEK_OF_CYBER }]);
    expect(await balance(policyId)).toBe(0);
  });

  it("is marked failed when Stripe clearly refuses, and a retry sends a new one", async () => {
    const policyId = await policyOwedARefund();
    fake.refundFault = "rejected";
    expect((await refundCredit(policyId)).message).toMatch(/failed: This payment can't be refunded/);
    expect(fake.refunds).toHaveLength(0);
    expect(await refundRows(policyId)).toMatchObject([{ status: "FAILED", stripeRefundId: null }]);
    expect(await balance(policyId)).toBe(-WEEK_OF_CYBER);

    expect(await refundCredit(policyId)).toMatchObject({ refundedCents: WEEK_OF_CYBER });
    expect(fake.refunds).toHaveLength(1);
    expect((await refundRows(policyId)).map((r) => r.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(await balance(policyId)).toBe(0);
  });
});

describe("news about a payment arriving out of order", () => {
  it("never sets a settled payment back to pending", async () => {
    const { policyId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "processing", "PENDING");
    const whileProcessing = { ...intent } as unknown as Stripe.PaymentIntent;
    await stripeConfirms(intent);

    // A "processing" notice from before it settled is handled late. So is a "cancelled" one.
    await recordPaymentIntent(whileProcessing);
    await recordPaymentIntent({ ...whileProcessing, status: "canceled" } as Stripe.PaymentIntent);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("SUCCEEDED");
    expect(await balance(policyId)).toBe(0);
  });

  it("repairs a paid payment that was left marked pending", async () => {
    const { policyId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    // The state the old code could leave behind: paid on the statement, pending in the payments table.
    await db.payment.update({ where: { id: paymentId }, data: { status: "PENDING" } });

    // Opening the policy asks Stripe again and puts it right, without posting a second line.
    await reconcilePending(policyId);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("SUCCEEDED");
    expect((await loadPolicyView(policyId))!.statement.filter((r) => r.kind === "PAYMENT")).toHaveLength(1);
  });
});

describe("telling the broker about a refund", () => {
  it("reports a refund Stripe is still working on as pending, not as refunded", async () => {
    const { policyId, cyberChangeId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    await moveCyberTo(policyId, cyberChangeId, "2026-11-01");

    // A refund to a bank account takes days.
    fake.refundStatus = "pending";
    expect(await refundCredit(policyId)).toEqual({ refundedCents: 0, pendingCents: WEEK_OF_CYBER, message: undefined });
    // The credit is still on the statement, and the refund shows as pending.
    expect(await balance(policyId)).toBe(-WEEK_OF_CYBER);
    expect(await db.refund.findMany({ where: { policyId }, select: { status: true } })).toEqual([{ status: "PENDING" }]);

    // When Stripe finishes it, it reaches the statement.
    fake.refunds[0].status = "succeeded";
    await reconcilePending(policyId);
    expect(await balance(policyId)).toBe(0);
    // And nothing more is refunded.
    expect(await refundCredit(policyId)).toMatchObject({ refundedCents: 0, pendingCents: 0 });
    expect(fake.refunds).toHaveLength(1);
  });
});

describe("a refund that Stripe reports as succeeded and later as failed", () => {
  it("keeps the refund line, cancels it out once, and puts the customer back in credit", async () => {
    const { policyId, cyberChangeId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    await moveCyberTo(policyId, cyberChangeId, "2026-11-01");
    expect(await refundCredit(policyId)).toMatchObject({ refundedCents: WEEK_OF_CYBER });
    expect(await balance(policyId)).toBe(0);

    // Days later the customer's bank turns the refund away, and Stripe changes it to failed.
    const failed = { ...fake.refunds[0], status: "failed", failure_reason: "expired_or_canceled_card" } as unknown as Stripe.Refund;
    await recordRefund(failed);

    // The customer is owed the money again, and the statement shows both the refund and its failure.
    expect(await balance(policyId)).toBe(-WEEK_OF_CYBER);
    const view = (await loadPolicyView(policyId))!;
    expect(view.statement.slice(-2)).toMatchObject([
      { kind: "REFUND", amountCents: WEEK_OF_CYBER, reversedByLine: view.statement.length },
      {
        kind: "REFUND",
        amountCents: -WEEK_OF_CYBER,
        reversesLine: view.statement.length - 1,
        description: "Refund failed and was not paid out: The card it was going back to has expired or been cancelled.",
      },
    ]);
    expect(view.totals.refundedCents).toBe(0);
    expect(view.refunds).toMatchObject([{ status: "FAILED", failureReason: "The card it was going back to has expired or been cancelled." }]);

    // Hearing about the failure again, or a stale "succeeded", changes nothing.
    await recordRefund(failed);
    await recordRefund({ ...failed, status: "succeeded" } as Stripe.Refund);
    expect(await balance(policyId)).toBe(-WEEK_OF_CYBER);
    expect((await loadPolicyView(policyId))!.statement).toHaveLength(view.statement.length);

    // The credit is there for the broker to resolve. Retry refund sends a new refund.
    expect(await refundCredit(policyId)).toMatchObject({ refundedCents: WEEK_OF_CYBER });
    expect(fake.refunds).toHaveLength(2);
    expect(await balance(policyId)).toBe(0);
  });

  it("just marks a refund failed if it never reached the statement", async () => {
    const { policyId, cyberChangeId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    await moveCyberTo(policyId, cyberChangeId, "2026-11-01");
    fake.refundStatus = "pending";
    await refundCredit(policyId);
    const linesBefore = (await loadPolicyView(policyId))!.statement.length;

    await recordRefund({ ...fake.refunds[0], status: "failed", failure_reason: "declined" } as unknown as Stripe.Refund);
    const view = (await loadPolicyView(policyId))!;
    expect(view.statement).toHaveLength(linesBefore);
    expect(view.balanceCents).toBe(-WEEK_OF_CYBER);
    expect(view.refunds).toMatchObject([{ status: "FAILED" }]);
  });
});

describe("a payment the customer's bank takes back after it cleared", () => {
  const dispute = (intentId: string, amount: number, status = "lost") =>
    ({ id: "dp_1", payment_intent: intentId, amount, status, reason: "insufficient_funds" }) as unknown as Stripe.Dispute;

  it("keeps the payment line, cancels it out once, and makes the amount due again", async () => {
    const { policyId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    expect(await balance(policyId)).toBe(0);
    const paid = GL + CYBER_FROM_OCT_25;

    // A dispute that is still open isn't acted on. Once it is lost, the money is gone.
    await recordDispute(dispute(intent.id, paid, "needs_response"));
    expect(await balance(policyId)).toBe(0);
    await recordDispute(dispute(intent.id, paid));

    const view = (await loadPolicyView(policyId))!;
    expect(view.balanceCents).toBe(paid);
    expect(view.statement.slice(-2)).toMatchObject([
      { kind: "PAYMENT", amountCents: -paid, reversedByLine: view.statement.length },
      {
        kind: "PAYMENT",
        amountCents: paid,
        reversesLine: view.statement.length - 1,
        description: "Payment returned by the bank (insufficient funds)",
      },
    ]);
    expect(view.totals.paidCents).toBe(0);
    expect(view.payments).toMatchObject([{ id: paymentId, status: "FAILED", failureReason: "Returned by the bank after it had cleared." }]);
    // The policyholder is told why the amount is due again.
    expect(view.dueBecause.map((r) => [r.title, r.netCents])).toEqual([
      ["Payment returned by the bank (insufficient funds)", paid],
    ]);

    // Hearing about it again changes nothing, and neither does Stripe still calling the payment "succeeded".
    await recordDispute(dispute(intent.id, paid));
    await stripeConfirms(intent);
    await reconcilePending(policyId);
    const after = (await loadPolicyView(policyId))!;
    expect(after.balanceCents).toBe(paid);
    expect(after.statement).toHaveLength(view.statement.length);
    expect(after.payments[0].status).toBe("FAILED");

    // The customer can pay again, with a new payment.
    const again = await startPayment(policyId);
    expect(again.amountCents).toBe(paid);
    expect(again.clientSecret).not.toBe(`${intent.id}_secret`);
  });

  it("can't be refunded against", async () => {
    const { policyId, cyberChangeId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    await recordDispute(dispute(intent.id, GL + CYBER_FROM_OCT_25));
    // A later correction lowers what is owed. Nothing was paid in the end, so nothing is refunded.
    await moveCyberTo(policyId, cyberChangeId, "2026-11-01");
    expect(await refundCredit(policyId)).toMatchObject({ refundedCents: 0, pendingCents: 0 });
    expect(fake.refunds).toHaveLength(0);
    expect(await balance(policyId)).toBe(GL + CYBER_FROM_OCT_25 - WEEK_OF_CYBER);
  });
});

describe("an amount due that is too small to collect", () => {
  /** A paid-up policy that then owes four cents, as a correction across a leap year can leave. */
  async function policyOwingFourCents() {
    const { policyId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    await db.ledgerEntry.create({ data: { policyId, kind: "CHARGE", amountCents: 4, description: "Cyber Liability: 7 more days" } });
    return policyId;
  }

  it("is kept on the statement, and no payment is started for it", async () => {
    const policyId = await policyOwingFourCents();
    await expect(startPayment(policyId)).rejects.toThrow(/\$0\.04 is less than \$0\.50, the smallest amount that can be collected/);
    expect(await balance(policyId)).toBe(4);
    expect(fake.intents.size).toBe(1); // only the payment already made
    expect(await db.payment.count({ where: { policyId, status: "INITIATED" } })).toBe(0);

    // The next charge takes it over the minimum, and the four cents are collected with it.
    await db.ledgerEntry.create({ data: { policyId, kind: "CHARGE", amountCents: 1_400, description: "Cyber Liability: a week more" } });
    expect((await startPayment(policyId)).amountCents).toBe(1_404);
  });

  it("closes a payment form that was open when the amount dropped below the minimum", async () => {
    const { policyId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "requires_payment_method");
    // All but four cents is settled another way while the form is open.
    await db.ledgerEntry.create({
      data: { policyId, kind: "CREDIT", amountCents: -(GL + CYBER_FROM_OCT_25 - 4), description: "Unused days credited" },
    });
    await syncOpenPayments(policyId);
    expect(intent.status).toBe("canceled");
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("FAILED");
    expect(await balance(policyId)).toBe(4);
  });
});

