import "server-only";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { allocateRefund, formatUSD } from "@/lib/engine";
import { logIntegrationEvent } from "@/lib/integrations/log";
import { stripe } from "@/lib/integrations/stripe";

/**
 * Collecting premium and returning credits through Stripe (test mode).
 *
 * Rules:
 *  - A payment or refund only reaches the statement when Stripe's servers say
 *    it succeeded. We never trust the browser for that.
 *  - Recording is idempotent: hearing about the same payment twice (a webhook
 *    and a status check, or a webhook retry) posts one statement line.
 */

export class PaymentError extends Error {}

const CANCELLED_NOTE = "The payment was cancelled.";

export async function balanceCents(policyId: string): Promise<number> {
  const sum = await db.ledgerEntry.aggregate({ where: { policyId }, _sum: { amountCents: true } });
  return sum._sum.amountCents ?? 0;
}

/* ------------------------------------------------------------------ */
/* Paying                                                              */
/* ------------------------------------------------------------------ */

/**
 * Starts (or resumes) a payment for the full amount due and returns the
 * client secret the browser needs to show Stripe's payment form.
 */
export async function startPayment(policyId: string): Promise<{ clientSecret: string; amountCents: number }> {
  const due = await balanceCents(policyId);
  if (due <= 0) throw new PaymentError("Nothing is due on this policy.");

  // Reuse an unfinished attempt rather than leaving stray PaymentIntents behind.
  const open = await db.payment.findFirst({
    where: { policyId, status: { in: ["INITIATED", "PENDING"] }, stripePaymentIntentId: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (open) {
    let intent = await stripe().paymentIntents.retrieve(open.stripePaymentIntentId!);
    if (intent.status === "processing") {
      throw new PaymentError("A payment is already being processed. It can take a little while to clear.");
    }
    const unfinished =
      intent.status === "requires_payment_method" ||
      intent.status === "requires_confirmation" ||
      intent.status === "requires_action";
    if (unfinished && !intent.last_payment_error) {
      if (intent.amount !== due) {
        intent = await stripe().paymentIntents.update(intent.id, { amount: due });
        await db.payment.update({ where: { id: open.id }, data: { amountCents: due } });
        await logIntegrationEvent({
          provider: "stripe",
          direction: "OUTBOUND",
          eventType: "payment_intent.update",
          externalId: intent.id,
          policyId,
          payload: { amount: due, status: intent.status },
        });
      }
      return { clientSecret: intent.client_secret!, amountCents: due };
    }
    // Succeeded, failed, or cancelled: record it and start fresh.
    await recordPaymentIntent(intent);
    if ((await balanceCents(policyId)) <= 0) throw new PaymentError("This policy has just been paid.");
  }

  // A failed attempt keeps its own record. Cancel its PaymentIntent so it can
  // never be completed later, on top of the new attempt.
  const failed = await db.payment.findMany({
    where: { policyId, status: "FAILED", stripePaymentIntentId: { not: null }, failureReason: { not: CANCELLED_NOTE } },
  });
  for (const f of failed) {
    try {
      const intent = await stripe().paymentIntents.retrieve(f.stripePaymentIntentId!);
      if (intent.status !== "canceled" && intent.status !== "succeeded") {
        await stripe().paymentIntents.cancel(intent.id);
      }
    } catch (error) {
      console.error("Could not cancel a failed PaymentIntent", error);
    }
  }

  const policy = await db.policy.findUniqueOrThrow({ where: { id: policyId }, include: { customer: true } });
  const payment = await db.payment.create({ data: { policyId, amountCents: due } });
  const intent = await stripe().paymentIntents.create(
    {
      amount: due,
      currency: "usd",
      automatic_payment_methods: { enabled: true },
      description: `Premium for policy ${policy.policyNumber}`,
      metadata: { paymentId: payment.id, policyId, policyNumber: policy.policyNumber },
    },
    { idempotencyKey: `payment-${payment.id}` },
  );
  await db.payment.update({ where: { id: payment.id }, data: { stripePaymentIntentId: intent.id } });
  await logIntegrationEvent({
    provider: "stripe",
    direction: "OUTBOUND",
    eventType: "payment_intent.create",
    externalId: intent.id,
    policyId,
    payload: { amount: intent.amount, currency: intent.currency, status: intent.status, metadata: intent.metadata },
  });
  return { clientSecret: intent.client_secret!, amountCents: due };
}

/**
 * Brings our payment record in line with what Stripe says. Called from the
 * webhook, and as a backstop when someone opens the policy page while a
 * payment is pending.
 */
export async function recordPaymentIntent(intent: Stripe.PaymentIntent) {
  const payment = await db.payment.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!payment) return;

  if (intent.status === "succeeded") {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Policy" WHERE id = ${payment.policyId} FOR UPDATE`;
      const already = await tx.ledgerEntry.findUnique({ where: { paymentId: payment.id } });
      if (already) return;
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: "SUCCEEDED", amountCents: intent.amount_received, failureReason: null },
      });
      await tx.ledgerEntry.create({
        data: {
          policyId: payment.policyId,
          kind: "PAYMENT",
          amountCents: -intent.amount_received,
          description: `Payment received (${methodLabel(intent)})`,
          paymentId: payment.id,
        },
      });
    });
    return;
  }

  if (payment.status === "SUCCEEDED") return; // Never downgrade a completed payment.

  if (intent.status === "canceled") {
    // Keep the original decline reason if there was one.
    if (payment.status !== "FAILED") {
      await db.payment.update({ where: { id: payment.id }, data: { status: "FAILED", failureReason: CANCELLED_NOTE } });
    }
  } else if (intent.status === "requires_payment_method" && intent.last_payment_error) {
    await db.payment.update({
      where: { id: payment.id },
      data: { status: "FAILED", failureReason: intent.last_payment_error.message ?? "The payment was declined." },
    });
  } else if (intent.status === "processing" && payment.status !== "PENDING") {
    await db.payment.update({ where: { id: payment.id }, data: { status: "PENDING", failureReason: null } });
  }
}

function methodLabel(intent: Stripe.PaymentIntent) {
  const type = intent.payment_method_types?.length === 1 ? intent.payment_method_types[0] : null;
  const pm = typeof intent.payment_method === "object" ? intent.payment_method : null;
  const kind = pm?.type ?? type;
  if (kind === "card") return pm?.card?.last4 ? `card ending ${pm.card.last4}` : "card";
  if (kind === "us_bank_account") return "bank account";
  return "Stripe";
}

/** Backstop for missed webhooks: ask Stripe about any payments or refunds still pending. */
export async function reconcilePending(policyId: string) {
  const payments = await db.payment.findMany({
    where: { policyId, status: { in: ["INITIATED", "PENDING"] }, stripePaymentIntentId: { not: null } },
  });
  for (const p of payments) {
    try {
      const intent = await stripe().paymentIntents.retrieve(p.stripePaymentIntentId!, {
        expand: ["payment_method"],
      });
      await recordPaymentIntent(intent);
    } catch (error) {
      console.error("Could not check payment with Stripe", error);
    }
  }
  const refunds = await db.refund.findMany({
    where: { policyId, status: "PENDING", stripeRefundId: { not: null } },
  });
  for (const r of refunds) {
    try {
      await recordRefund(await stripe().refunds.retrieve(r.stripeRefundId!));
    } catch (error) {
      console.error("Could not check refund with Stripe", error);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Refunding                                                           */
/* ------------------------------------------------------------------ */

/**
 * If the customer has a credit (they've paid more than they owe), send it
 * back to their card. Runs after every change to a policy, and can be re-run
 * by the broker if a refund failed.
 *
 * A credit is first absorbed by anything else owed, simply because the
 * balance is one running total. Only a negative balance is refunded.
 */
export async function refundCredit(policyId: string, transactionId?: string): Promise<{ refundedCents: number; message?: string }> {
  // Decide what to refund under a lock, so two runs can't both refund the same credit.
  const planned = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Policy" WHERE id = ${policyId} FOR UPDATE`;
    const sum = await tx.ledgerEntry.aggregate({ where: { policyId }, _sum: { amountCents: true } });
    const inFlight = await tx.refund.aggregate({
      where: { policyId, status: "PENDING" },
      _sum: { amountCents: true },
    });
    const credit = -(sum._sum.amountCents ?? 0) - (inFlight._sum.amountCents ?? 0);
    if (credit <= 0) return { rows: [], shortfallCents: 0 };

    const payments = await tx.payment.findMany({
      where: { policyId, status: "SUCCEEDED" },
      include: { refunds: { where: { status: { not: "FAILED" } } } },
    });
    const { allocations, shortfallCents } = allocateRefund(
      credit,
      payments.map((p) => ({
        paymentId: p.id,
        amountCents: p.amountCents,
        alreadyRefundedCents: p.refunds.reduce((s, r) => s + r.amountCents, 0),
        paidAt: p.createdAt,
      })),
    );
    const rows = [];
    for (const a of allocations) {
      rows.push(
        await tx.refund.create({
          data: {
            policyId,
            paymentId: a.paymentId,
            amountCents: a.amountCents,
            status: "PENDING",
            transactionId: transactionId ?? null,
          },
          include: { payment: true },
        }),
      );
    }
    return { rows, shortfallCents };
  });

  let refundedCents = 0;
  let message: string | undefined;
  for (const row of planned.rows) {
    try {
      const refund = await stripe().refunds.create(
        {
          payment_intent: row.payment.stripePaymentIntentId!,
          amount: row.amountCents,
          reason: "requested_by_customer",
          metadata: { refundId: row.id, policyId },
        },
        { idempotencyKey: `refund-${row.id}` },
      );
      await db.refund.update({ where: { id: row.id }, data: { stripeRefundId: refund.id } });
      await logIntegrationEvent({
        provider: "stripe",
        direction: "OUTBOUND",
        eventType: "refund.create",
        externalId: refund.id,
        policyId,
        payload: { amount: refund.amount, status: refund.status, payment_intent: row.payment.stripePaymentIntentId, metadata: refund.metadata },
      });
      await recordRefund(refund);
      if (refund.status === "succeeded" || refund.status === "pending") refundedCents += row.amountCents;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Stripe rejected the refund.";
      await db.refund.update({ where: { id: row.id }, data: { status: "FAILED", failureReason: reason } });
      await logIntegrationEvent({
        provider: "stripe",
        direction: "OUTBOUND",
        eventType: "refund.create.failed",
        policyId,
        payload: { refundId: row.id, amount: row.amountCents, error: reason },
      });
      message = `A refund of ${formatUSD(row.amountCents)} failed: ${reason}`;
    }
  }
  if (planned.shortfallCents > 0) {
    message = `${formatUSD(planned.shortfallCents)} of the credit couldn't be refunded to a card payment.`;
  }
  return { refundedCents, message };
}

/** Brings our refund record in line with Stripe. Idempotent, like payments. */
export async function recordRefund(refund: Stripe.Refund) {
  const row = await db.refund.findUnique({ where: { stripeRefundId: refund.id } });
  if (!row) return;

  if (refund.status === "succeeded") {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Policy" WHERE id = ${row.policyId} FOR UPDATE`;
      const already = await tx.ledgerEntry.findUnique({ where: { refundId: row.id } });
      if (already) return;
      await tx.refund.update({ where: { id: row.id }, data: { status: "SUCCEEDED", failureReason: null } });
      await tx.ledgerEntry.create({
        data: {
          policyId: row.policyId,
          kind: "REFUND",
          amountCents: row.amountCents,
          description: "Refund sent to your original payment method",
          refundId: row.id,
          postedByTransactionId: row.transactionId,
        },
      });
    });
  } else if (refund.status === "failed" || refund.status === "canceled") {
    if (row.status === "SUCCEEDED") return;
    await db.refund.update({
      where: { id: row.id },
      data: { status: "FAILED", failureReason: refund.failure_reason ?? "The refund did not go through." },
    });
  }
}
