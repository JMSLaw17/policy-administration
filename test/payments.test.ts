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
  /** Makes the next attempt to cancel a payment fail, as when the connection drops. */
  cancelFails: false,
  /** Runs once, just before Stripe is next asked about a payment: the place other news can arrive. */
  meanwhile: null as null | (() => Promise<void>),
  /** Makes the next change to a payment's amount take this long to reach Stripe. */
  slowNextUpdateMs: 0,
  /** Disputes as Stripe holds them, by id. */
  disputes: new Map<string, unknown>(),
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
        retrieve: async (id: string) => {
          const meanwhile = fake.meanwhile;
          fake.meanwhile = null;
          await meanwhile?.();
          return fake.intents.get(id)!;
        },
        update: async (id: string, data: { amount: number }) => {
          // A slow request: Stripe applies it when it arrives, not when it was sent.
          const delay = fake.slowNextUpdateMs;
          fake.slowNextUpdateMs = 0;
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          return Object.assign(fake.intents.get(id)!, data);
        },
        cancel: async (id: string) => {
          const intent = fake.intents.get(id)!;
          if (fake.cancelFails || intent.status === "succeeded") {
            fake.cancelFails = false;
            throw new Stripe.errors.StripeConnectionError({ type: "api_error", message: "Could not cancel." });
          }
          return Object.assign(intent, { status: "canceled" });
        },
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
      disputes: { retrieve: async (id: string) => fake.disputes.get(id)! },
      // The stand-in trusts the signature. The real check is Stripe's own code.
      webhooks: { constructEventAsync: async (body: string) => JSON.parse(body) },
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
  fake.cancelFails = false;
  fake.meanwhile = null;
  fake.slowNextUpdateMs = 0;
  fake.disputes.clear();
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

  it("isn't put back up by a slow update for an earlier change", async () => {
    const { policyId, cyberChangeId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "requires_payment_method");
    const full = GL + CYBER_FROM_OCT_25;

    // A first correction takes a week off. Its update to Stripe is slow to arrive.
    await moveCyberTo(policyId, cyberChangeId, "2026-11-01");
    fake.slowNextUpdateMs = 200;
    const firstUpdate = syncOpenPayments(policyId);
    await new Promise((resolve) => setTimeout(resolve, 50)); // it is on its way to Stripe

    // Meanwhile a second correction takes another week off, and its update is sent.
    await moveCyberTo(policyId, cyberChangeId, "2026-11-08");
    await syncOpenPayments(policyId);
    await firstUpdate;

    // The payment ends at what is due now. The first update didn't land last and undo the second.
    const due = full - 2 * WEEK_OF_CYBER;
    expect(await balance(policyId)).toBe(due);
    expect(intent.amount).toBe(due);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).amountCents).toBe(due);
    // And checkout offers that amount.
    expect((await startPayment(policyId)).amountCents).toBe(due);
    expect(fake.intents.size).toBe(1);
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

describe("opening checkout again after a declined card", () => {
  it("records a retry that went through on the old form, and doesn't offer a second payment", async () => {
    const { policyId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "requires_payment_method", "FAILED");
    // The customer tries again on the same form and it goes through. Stripe knows. We haven't heard yet.
    Object.assign(intent, { status: "succeeded", amount_received: intent.amount });

    // Checkout is opened again before the news arrives. The old attempt is checked first.
    await expect(startPayment(policyId)).rejects.toThrow("Your earlier payment went through, so nothing more is due.");
    expect(fake.intents.size).toBe(1); // no second PaymentIntent, so nothing can be collected twice
    expect(await db.payment.findMany({ where: { policyId }, select: { id: true, status: true } })).toEqual([
      { id: paymentId, status: "SUCCEEDED" },
    ]);
    expect(await balance(policyId)).toBe(0);
    expect(fake.refunds).toHaveLength(0);
  });

  it("closes a declined attempt for good, and doesn't ask Stripe about it again", async () => {
    const { policyId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "requires_payment_method", "FAILED");

    await startPayment(policyId);
    expect(intent.status).toBe("canceled");
    const closed = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(closed).toMatchObject({ status: "FAILED", failureReason: "Your card was declined." });
    expect(closed.closedAt).not.toBeNull();

    // Opening checkout again goes straight to the open attempt.
    let asked = false;
    fake.meanwhile = async () => {
      asked = true;
    };
    await startPayment(policyId);
    expect(asked).toBe(true); // Stripe was asked about the open attempt...
    expect(fake.intents.size).toBe(2); // ...and nothing new was created
  });

  it("doesn't create a second attempt when a decline is recorded while checkout is starting", async () => {
    const { policyId } = await policyWithCyber();
    // An older declined attempt, so that starting checkout has to ask Stripe about something,
    // and the attempt whose form the customer has open.
    const older = await openPayment(policyId, "requires_payment_method", "FAILED");
    const inUse = await openPayment(policyId, "requires_payment_method");

    // While checkout is starting, after the declined attempts have been listed, the customer's
    // card is declined on the open form and the news is recorded. That form can still be retried.
    fake.meanwhile = async () => {
      await recordPaymentIntent({
        ...(inUse.intent as unknown as Stripe.PaymentIntent),
        last_payment_error: { message: "Your card was declined." } as Stripe.PaymentIntent.LastPaymentError,
      });
    };
    const started = await startPayment(policyId);

    // The reservation saw the new decline, under the policy lock, and created nothing until that
    // attempt was closed at Stripe. So only the newest attempt can collect.
    expect(older.intent.status).toBe("canceled");
    expect(inUse.intent.status).toBe("canceled");
    expect(started.clientSecret).toBe("pi_3_secret");
    const collectable = [...fake.intents.values()].filter((i) => i.status !== "canceled");
    expect(collectable.map((i) => i.id)).toEqual(["pi_3"]);
    expect(
      await db.payment.findMany({ where: { policyId }, orderBy: { createdAt: "asc" }, select: { status: true, closedAt: true } }),
    ).toMatchObject([
      { status: "FAILED", closedAt: expect.any(Date) },
      { status: "FAILED", closedAt: expect.any(Date) },
      { status: "INITIATED", closedAt: null },
    ]);
  });

  it("doesn't offer a new payment while the old one is being processed", async () => {
    const { policyId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "requires_payment_method", "FAILED");
    intent.status = "processing";

    await expect(startPayment(policyId)).rejects.toThrow("A payment is already being processed.");
    expect(fake.intents.size).toBe(1);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("PENDING");
  });

  it("doesn't offer a new payment if closing the old one can't be confirmed", async () => {
    const { policyId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "requires_payment_method", "FAILED");
    fake.cancelFails = true;

    await expect(startPayment(policyId)).rejects.toThrow("We couldn't close your earlier payment attempt");
    expect(fake.intents.size).toBe(1);
    expect(await db.payment.count({ where: { policyId } })).toBe(1);

    // Trying again closes the old attempt and starts a new one, as before.
    const started = await startPayment(policyId);
    expect(intent.status).toBe("canceled");
    expect(started.clientSecret).toBe("pi_2_secret");
    expect(
      await db.payment.findMany({ where: { policyId }, orderBy: { createdAt: "asc" }, select: { status: true, failureReason: true } }),
    ).toEqual([
      { status: "FAILED", failureReason: "Your card was declined." },
      { status: "INITIATED", failureReason: null },
    ]);
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

  it("isn't undone by a \"succeeded\" that arrives after the failure", async () => {
    const { policyId, cyberChangeId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    await moveCyberTo(policyId, cyberChangeId, "2026-11-01");
    // The refund is accepted but not finished, so it isn't on the statement yet.
    fake.refundStatus = "pending";
    await refundCredit(policyId);
    const linesBefore = (await loadPolicyView(policyId))!.statement.length;

    // The failure is recorded first. Then a slow "succeeded" answer for the same refund turns up.
    const known = fake.refunds[0] as unknown as Stripe.Refund;
    await recordRefund({ ...known, status: "failed", failure_reason: "declined" } as Stripe.Refund);
    await recordRefund({ ...known, status: "succeeded" } as Stripe.Refund);

    // The refund stays failed, nothing is posted, and the customer is still owed the money.
    const view = (await loadPolicyView(policyId))!;
    expect(view.refunds).toMatchObject([{ status: "FAILED" }]);
    expect(view.statement).toHaveLength(linesBefore);
    expect(view.balanceCents).toBe(-WEEK_OF_CYBER);
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
  const dispute = (intentId: string, amount: number, status = "lost", id = "dp_1") =>
    ({ id, payment_intent: intentId, amount, status, reason: "insufficient_funds" }) as unknown as Stripe.Dispute;

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
      { kind: "PAYMENT", amountCents: -paid, returnedCents: paid },
      {
        kind: "PAYMENT",
        amountCents: paid,
        returnsLine: view.statement.length - 1,
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

  it("is kept and applied when the return is heard about before the payment itself", async () => {
    const { policyId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "processing", "PENDING");
    const paid = GL + CYBER_FROM_OCT_25;

    // The bank's return arrives first. As far as the app knows, the payment is still clearing,
    // and so does Stripe when asked (the stand-in still says "processing").
    await recordDispute(dispute(intent.id, paid));
    expect(await balance(policyId)).toBe(paid);
    expect(await db.paymentReturn.count({ where: { paymentId } })).toBe(1);
    expect((await loadPolicyView(policyId))!.statement.filter((r) => r.kind === "PAYMENT")).toHaveLength(0);

    // Then the news that the payment succeeded. Both lines are posted, and the amount is still due.
    await stripeConfirms(intent);
    const view = (await loadPolicyView(policyId))!;
    expect(view.statement.slice(-2).map((r) => [r.kind, r.amountCents])).toEqual([
      ["PAYMENT", -paid],
      ["PAYMENT", paid],
    ]);
    expect(view.balanceCents).toBe(paid);
    expect(view.payments).toMatchObject([{ status: "FAILED", failureReason: "Returned by the bank after it had cleared." }]);

    // Nothing more happens however often either piece of news is repeated.
    await recordDispute(dispute(intent.id, paid));
    await stripeConfirms(intent);
    expect((await loadPolicyView(policyId))!.statement).toHaveLength(view.statement.length);
  });

  it("asks Stripe about the payment when the return arrives first, and applies both at once", async () => {
    const { policyId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "processing", "PENDING");
    const paid = GL + CYBER_FROM_OCT_25;
    // Stripe already has the payment as succeeded. Only our record is behind.
    Object.assign(intent, { status: "succeeded", amount_received: intent.amount });

    await recordDispute(dispute(intent.id, paid));
    const view = (await loadPolicyView(policyId))!;
    expect(view.statement.slice(-2).map((r) => [r.kind, r.amountCents])).toEqual([
      ["PAYMENT", -paid],
      ["PAYMENT", paid],
    ]);
    expect(view.balanceCents).toBe(paid);
  });

  it("counts two separate partial returns on one payment, each once", async () => {
    const { policyId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);

    await recordDispute(dispute(intent.id, 10_000, "lost", "dp_first"));
    await recordDispute(dispute(intent.id, 5_000, "lost", "dp_second"));
    // Each is repeated, as a webhook retry would.
    await recordDispute(dispute(intent.id, 10_000, "lost", "dp_first"));
    await recordDispute(dispute(intent.id, 5_000, "lost", "dp_second"));

    const view = (await loadPolicyView(policyId))!;
    expect(view.balanceCents).toBe(15_000);
    expect(view.statement.slice(-2).map((r) => [r.kind, r.amountCents, r.returnsLine])).toEqual([
      ["PAYMENT", 10_000, view.statement.length - 2],
      ["PAYMENT", 5_000, view.statement.length - 2],
    ]);
    // Part of the payment still stands, so it is still a payment, with the returned part noted.
    expect(view.payments).toMatchObject([{ id: paymentId, status: "SUCCEEDED", returnedCents: 15_000 }]);
    expect(view.statement.at(-3)).toMatchObject({ kind: "PAYMENT", returnedCents: 15_000 });
    // The policyholder is told what is due and why, and the rows add up.
    expect(view.dueBecause.map((r) => r.netCents)).toEqual([10_000, 5_000]);
  });

  it("never takes back more than was paid", async () => {
    const { policyId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    const paid = GL + CYBER_FROM_OCT_25;
    await recordDispute(dispute(intent.id, paid - 1_000, "lost", "dp_first"));
    await recordDispute(dispute(intent.id, 5_000, "lost", "dp_second"));
    expect(await balance(policyId)).toBe(paid);
  });

  it("is recorded when Stripe's webhook reports the dispute, which carries no policy of its own", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const { policyId } = await policyWithCyber();
    const { intent } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    const paid = GL + CYBER_FROM_OCT_25;

    // A dispute event has no metadata of ours. The policy is found through the payment it is about.
    const send = (type: string, object: Record<string, unknown>) =>
      POST(
        new Request("http://localhost/api/stripe/webhook", {
          method: "POST",
          headers: { "stripe-signature": "t=1,v1=test" },
          body: JSON.stringify({ id: `evt_${type}`, type, created: 1, data: { object } }),
        }),
      ).then((response) => response.json());
    const lost = dispute(intent.id, paid);
    fake.disputes.set(lost.id, lost);

    expect(await send("charge.dispute.closed", { id: lost.id, payment_intent: intent.id })).toEqual({ received: true });
    expect(await send("charge.dispute.closed", { id: lost.id, payment_intent: intent.id })).toEqual({ received: true });
    const view = (await loadPolicyView(policyId))!;
    expect(view.balanceCents).toBe(paid);
    expect(view.statement.filter((r) => r.returnsLine !== null)).toHaveLength(1);
    // It is in the integration log, against the policy.
    expect(await db.integrationEvent.count({ where: { policyId, eventType: "charge.dispute.closed", direction: "INBOUND" } })).toBe(2);

    // A dispute on a payment this copy of the app doesn't know is ignored and not logged.
    expect(await send("charge.dispute.closed", { id: "dp_other", payment_intent: "pi_someone_elses" })).toMatchObject({
      ignored: "not one of this app's policies",
    });
    expect(await db.integrationEvent.count({ where: { eventType: "charge.dispute.closed" } })).toBe(2);
  });

  it("stays returned whatever older news about the payment is replayed", async () => {
    const { policyId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    const paid = GL + CYBER_FROM_OCT_25;
    await recordDispute(dispute(intent.id, paid));
    const lines = (await loadPolicyView(policyId))!.statement.length;
    const status = async () => {
      const p = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
      return [p.status, p.failureReason];
    };
    const returned = ["FAILED", "Returned by the bank after it had cleared."];

    // "Processing", then "succeeded": the pair that used to relabel it as a successful payment.
    const news = intent as unknown as Stripe.PaymentIntent;
    await recordPaymentIntent({ ...news, status: "processing" } as Stripe.PaymentIntent);
    expect(await status()).toEqual(returned);
    await recordPaymentIntent({ ...news, status: "succeeded" } as Stripe.PaymentIntent);
    expect(await status()).toEqual(returned);
    // A late decline or cancellation doesn't change it either.
    await recordPaymentIntent({
      ...news,
      status: "requires_payment_method",
      last_payment_error: { message: "Your card was declined." },
    } as Stripe.PaymentIntent);
    await recordPaymentIntent({ ...news, status: "canceled" } as Stripe.PaymentIntent);
    expect(await status()).toEqual(returned);

    const view = (await loadPolicyView(policyId))!;
    expect(view.balanceCents).toBe(paid);
    expect(view.statement).toHaveLength(lines);
  });

  it("is put right if it was left marked as a successful payment", async () => {
    const { policyId } = await policyWithCyber();
    const { intent, paymentId } = await openPayment(policyId, "processing", "PENDING");
    await stripeConfirms(intent);
    await recordDispute(dispute(intent.id, GL + CYBER_FROM_OCT_25));
    // The state the earlier code could leave behind.
    await db.payment.update({ where: { id: paymentId }, data: { status: "SUCCEEDED", failureReason: null } });

    // The amounts on the statement say it was returned in full, so the next news about it repairs the status.
    await stripeConfirms(intent);
    expect(await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({
      status: "FAILED",
      failureReason: "Returned by the bank after it had cleared.",
    });
  });

  describe("leaves only what remains of the payment available to refund", () => {
    /**
     * A $1,095.00 payment, some of which the bank takes back. The policy is then cancelled from
     * its first day and the customer given a further $200.00 credit, so they are owed more than
     * the payment can carry. What gets refunded is therefore exactly what is left of the payment.
     */
    async function refundedAfter(returns: [disputeId: string, cents: number][]) {
      const policy = await issuePolicy({ customerId, startDate: "2026-10-01", coverageCodes: ["GL"], userId: brokerId });
      const { intent } = await openPayment(policy.id, "processing", "PENDING");
      await stripeConfirms(intent);
      for (const [id, cents] of returns) await recordDispute(dispute(intent.id, cents, "lost", id));

      await applyChange(policy.id, { kind: "CANCELLATION", effectiveDate: "2026-10-01" }, brokerId);
      await db.ledgerEntry.create({
        data: { policyId: policy.id, kind: "CREDIT", amountCents: -20_000, description: "Goodwill credit" },
      });
      const result = await refundCredit(policy.id);
      // Everything asked of Stripe was against this one payment.
      expect(fake.refunds.every((r) => r.payment_intent === intent.id)).toBe(true);
      return { ...result, sentToStripe: fake.refunds.map((r) => r.amount) };
    }
    const beyondThePayment = /\$200\.00 of the credit couldn't be refunded to a card payment/;

    it("$995.00 after a $100.00 return", async () => {
      const refund = await refundedAfter([["dp_first", 10_000]]);
      expect(refund).toMatchObject({ refundedCents: 99_500, sentToStripe: [99_500] });
      expect(refund.message).toMatch(beyondThePayment);
    });

    it("still $995.00 when the same $100.00 return is reported again", async () => {
      const refund = await refundedAfter([
        ["dp_first", 10_000],
        ["dp_first", 10_000],
      ]);
      expect(refund).toMatchObject({ refundedCents: 99_500, sentToStripe: [99_500] });
    });

    it("$945.00 after a separate $50.00 return as well", async () => {
      const refund = await refundedAfter([
        ["dp_first", 10_000],
        ["dp_second", 5_000],
      ]);
      expect(refund).toMatchObject({ refundedCents: 94_500, sentToStripe: [94_500] });
      expect(refund.message).toMatch(beyondThePayment);
    });
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

