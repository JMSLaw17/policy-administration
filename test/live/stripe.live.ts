import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addDays, todayISO } from "@/lib/engine";
import { stripe } from "@/lib/integrations/stripe";
import {
  balanceCents,
  PaymentError,
  reconcilePending,
  recordPaymentIntent,
  refundCredit,
  startPayment,
} from "@/lib/policies/payments";
import { loadDemoScenario } from "@/lib/policies/demo-scenario";
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

  it("shares one Stripe payment between two checkouts opened at the same moment", async () => {
    const policy = await issuePolicy({ customerId, startDate: "2026-10-01", coverageCodes: ["GL"], userId: brokerId });
    const started = await Promise.allSettled([startPayment(policy.id), startPayment(policy.id)]);

    // Stripe may turn away the second request while the first is still in flight. Either way,
    // there is one attempt and one PaymentIntent, and whoever got an answer got the same one.
    const secrets = started.flatMap((r) => (r.status === "fulfilled" ? [r.value.clientSecret] : []));
    expect(secrets.length).toBeGreaterThanOrEqual(1);
    expect(new Set(secrets).size).toBe(1);
    expect(await db.payment.count({ where: { policyId: policy.id } })).toBe(1);

    // Paying uses that same attempt, and the policy is settled by one payment.
    const { intentId } = await payWith(policy.id, VISA);
    expect(secrets[0].startsWith(intentId)).toBe(true);
    const v = await view(policy.id);
    expect(v.balanceCents).toBe(0);
    expect(v.payments.map((p) => p.status)).toEqual(["SUCCEEDED"]);
  });

  it("resumes a refund Stripe made but the app never heard about, without sending it twice", async () => {
    const policy = await issuePolicy({ customerId, startDate: "2026-10-01", coverageCodes: ["GL"], userId: brokerId });
    const { intentId } = await payWith(policy.id, VISA);
    const cancel = await applyChange(policy.id, { kind: "CANCELLATION", effectiveDate: "2027-04-01" }, brokerId);
    expect(await balanceCents(policy.id)).toBe(-54_900);

    // What an interruption leaves behind: our refund row, saved before Stripe was called, and
    // the refund itself at Stripe, made under that row's key. The row never got Stripe's id.
    const payment = await db.payment.findFirstOrThrow({ where: { policyId: policy.id, status: "SUCCEEDED" } });
    const row = await db.refund.create({
      data: { policyId: policy.id, paymentId: payment.id, amountCents: 54_900, status: "PENDING", transactionId: cancel.transaction.id },
    });
    const made = await stripe().refunds.create(
      { payment_intent: intentId, amount: 54_900, reason: "requested_by_customer", metadata: { refundId: row.id, policyId: policy.id } },
      { idempotencyKey: `refund-${row.id}` },
    );

    // Opening the policy finds Stripe's refund and records it. No second refund is created.
    await reconcilePending(policy.id);
    expect(await refundCredit(policy.id)).toMatchObject({ refundedCents: 0 });
    const atStripe = await stripe().refunds.list({ payment_intent: intentId, limit: 100 });
    expect(atStripe.data.map((r) => [r.id, r.amount])).toEqual([[made.id, 54_900]]);

    const v = await view(policy.id);
    expect(v.balanceCents).toBe(0);
    expect(v.refunds).toMatchObject([{ id: row.id, status: "SUCCEEDED", amountCents: 54_900, stripeRefundId: made.id }]);
    expect(v.statement.at(-1)).toMatchObject({ kind: "REFUND", amountCents: 54_900 });
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

  it("loads the demo scenario: paid, backdated, and ready for the correction and a refund", async () => {
    const scenario = await loadDemoScenario(brokerId);
    const today = todayISO();
    expect(scenario.actualCyberStart).toBe(addDays(today, -21));
    expect(scenario.recordedCyberStart).toBe(addDays(today, -14));

    let v = await view(scenario.policyId);
    expect(v.balanceCents).toBe(0);
    expect(v.demoLoadedAt).toEqual(expect.any(String));
    expect(v.startDate).toBe(addDays(today, -42));
    expect(v.statement.map((r) => r.kind)).toEqual(["CHARGE", "PAYMENT", "CHARGE", "PAYMENT"]);
    expect(v.payments.map((p) => p.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    // Recorded six and three weeks ago.
    expect(v.statement.map((r) => r.postedAt.slice(0, 10))).toEqual([
      addDays(today, -42),
      addDays(today, -42),
      addDays(today, -21),
      addDays(today, -21),
    ]);
    expect(v.history.map((h) => h.createdAt.slice(0, 10))).toEqual([addDays(today, -42), addDays(today, -21)]);

    // The reviewers' correction: a week earlier costs 7 more days.
    const cyberChange = v.history[1];
    const correct = (effectiveDate: string) =>
      applyChange(
        scenario.policyId,
        {
          kind: "CORRECTION",
          transactionId: cyberChange.id,
          event: { type: "COVERAGE_CHANGE", effectiveDate, add: ["CYBER"], remove: [] },
        },
        brokerId,
      );
    const cyberLine = v.statement[2];
    const perDay = Math.round(73_000 / v.termDays);
    const earlier = await correct(scenario.actualCyberStart);
    expect(earlier.preview.netChangeCents).toBeGreaterThanOrEqual(7 * perDay - 1);
    expect(earlier.preview.netChangeCents).toBeLessThanOrEqual(7 * perDay + 1);
    v = await view(scenario.policyId);
    expect(v.statement[2]).toMatchObject({ amountCents: cyberLine.amountCents, reversedByLine: 5 });
    expect(v.history.at(-1)!.createdAt.slice(0, 10) >= addDays(today, -1)).toBe(true); // made now, not backdated

    // And a correction the other way refunds against the real test payments.
    const later = await correct(addDays(scenario.recordedCyberStart, 7));
    const credit = -(await balanceCents(scenario.policyId));
    expect(credit).toBeGreaterThan(0);
    expect(await refundCredit(scenario.policyId, later.transaction.id)).toMatchObject({ refundedCents: credit });
    v = await view(scenario.policyId);
    expect(v.balanceCents).toBe(0);
    expect(v.refunds.every((r) => r.status === "SUCCEEDED")).toBe(true);
  });
});
