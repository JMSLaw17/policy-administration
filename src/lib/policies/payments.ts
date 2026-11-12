import "server-only";
import Stripe from "stripe";
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
const SUPERSEDED_NOTE = "Not submitted. Replaced by a new payment when the amount due went up.";
/** Reasons that mean an attempt is closed for good, as opposed to declined and open for another try. */
const CLOSED_NOTES = [CANCELLED_NOTE, SUPERSEDED_NOTE];

export async function balanceCents(policyId: string): Promise<number> {
  const sum = await db.ledgerEntry.aggregate({ where: { policyId }, _sum: { amountCents: true } });
  return sum._sum.amountCents ?? 0;
}

/* ------------------------------------------------------------------ */
/* Paying                                                              */
/* ------------------------------------------------------------------ */

/**
 * Starts (or resumes) a payment for the full amount due and returns the
 * client secret the browser needs to show Stripe's payment form, with the
 * amount that form will collect.
 *
 * A policy has at most one open attempt. The attempt is reserved in our
 * database, under a lock on the policy, before Stripe is asked for anything,
 * so two browser tabs (or a double click) share one attempt and one
 * PaymentIntent and can't both collect the same balance.
 */
export async function startPayment(policyId: string): Promise<{ clientSecret: string; amountCents: number }> {
  // A finished attempt is recorded and a new one reserved, so this can take a second pass.
  for (let pass = 0; pass < 3; pass++) {
    const { payment, due, isNew } = await reserveAttempt(policyId);

    let intent: Stripe.PaymentIntent;
    if (payment.stripePaymentIntentId) {
      intent = await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId);
    } else {
      if (isNew) await cancelFailedAttempts(policyId);
      intent = await createIntent(payment);
    }

    if (intent.status === "processing") {
      throw new PaymentError("A payment is already being processed. It can take a little while to clear.");
    }
    if (isUnfinished(intent) && !intent.last_payment_error) {
      if (intent.amount < due) {
        // More is due than this attempt was opened for. Its amount may already
        // be on a Pay button in another tab, and an amount a customer has been
        // shown is never raised. So this attempt is closed and a new one made.
        const cancelled = await stripe().paymentIntents.cancel(intent.id);
        await db.payment.updateMany({
          where: { id: payment.id, status: { not: "SUCCEEDED" } },
          data: { status: "FAILED", failureReason: SUPERSEDED_NOTE },
        });
        await logIntegrationEvent({
          provider: "stripe",
          direction: "OUTBOUND",
          eventType: "payment_intent.cancel",
          externalId: intent.id,
          policyId,
          payload: { reason: "More is due now, so a new payment was started", status: cancelled.status },
        });
        continue;
      }
      if (intent.amount > due) {
        intent = await stripe().paymentIntents.update(intent.id, { amount: due });
        await db.payment.update({ where: { id: payment.id }, data: { amountCents: due } });
        await logIntegrationEvent({
          provider: "stripe",
          direction: "OUTBOUND",
          eventType: "payment_intent.update",
          externalId: intent.id,
          policyId,
          payload: { amount: due, status: intent.status },
        });
      }
      return { clientSecret: intent.client_secret!, amountCents: intent.amount };
    }

    // Succeeded, failed, or cancelled: record it, which closes the attempt, and start fresh.
    await recordPaymentIntent(intent);
    await db.payment.updateMany({
      where: { id: payment.id, status: "INITIATED" },
      data: { status: "FAILED", failureReason: intent.last_payment_error?.message ?? CANCELLED_NOTE },
    });
    if ((await balanceCents(policyId)) <= 0) throw new PaymentError("This policy has just been paid.");
  }
  throw new PaymentError("We couldn't start the payment. Please try again.");
}

/**
 * Finds the policy's open attempt, or creates one for the amount due. Runs
 * under a lock on the policy, so concurrent requests get the same attempt.
 */
async function reserveAttempt(policyId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Policy" WHERE id = ${policyId} FOR UPDATE`;
    const sum = await tx.ledgerEntry.aggregate({ where: { policyId }, _sum: { amountCents: true } });
    const due = sum._sum.amountCents ?? 0;
    if (due <= 0) throw new PaymentError("Nothing is due on this policy.");

    const open = await tx.payment.findFirst({
      where: { policyId, status: { in: ["INITIATED", "PENDING"] } },
      orderBy: { createdAt: "desc" },
    });
    if (open) return { payment: open, due, isNew: false };
    return { payment: await tx.payment.create({ data: { policyId, amountCents: due } }), due, isNew: true };
  });
}

/**
 * Creates the Stripe PaymentIntent for a reserved attempt. The idempotency key
 * is the attempt's own id, so asking twice (a second tab, or a retry after an
 * interruption) gives back the same PaymentIntent rather than a second one.
 */
async function createIntent(payment: { id: string; policyId: string; amountCents: number }) {
  const policy = await db.policy.findUniqueOrThrow({ where: { id: payment.policyId } });
  const intent = await stripe().paymentIntents.create(
    {
      amount: payment.amountCents,
      currency: "usd",
      // Card settles at once; a bank debit shows a real "pending" state first.
      allowed_payment_method_types: ["card", "us_bank_account"],
      description: `Premium for policy ${policy.policyNumber}`,
      metadata: { paymentId: payment.id, policyId: payment.policyId, policyNumber: policy.policyNumber },
    },
    { idempotencyKey: `payment-${payment.id}` },
  );
  const saved = await db.payment.updateMany({
    where: { id: payment.id, stripePaymentIntentId: null },
    data: { stripePaymentIntentId: intent.id },
  });
  if (saved.count === 1) {
    await logIntegrationEvent({
      provider: "stripe",
      direction: "OUTBOUND",
      eventType: "payment_intent.create",
      externalId: intent.id,
      policyId: payment.policyId,
      payload: { amount: intent.amount, currency: intent.currency, status: intent.status, metadata: intent.metadata },
    });
  }
  return intent;
}

/**
 * A failed attempt keeps its own record. Its PaymentIntent is cancelled so it
 * can never be completed later, on top of a new attempt.
 */
async function cancelFailedAttempts(policyId: string) {
  const failed = await db.payment.findMany({
    where: { policyId, status: "FAILED", stripePaymentIntentId: { not: null }, failureReason: { notIn: CLOSED_NOTES } },
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
      // The status is set whether or not the statement line is already there,
      // so a payment that some older news marked pending is put right.
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: "SUCCEEDED", amountCents: intent.amount_received, failureReason: null },
      });
      const already = await tx.ledgerEntry.findUnique({ where: { paymentId: payment.id } });
      if (already) return;
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
    // The amount due can drop while a payment is clearing (a bank debit takes
    // days). If this payment left the customer in credit, send the extra back
    // now rather than waiting for the broker's next change.
    await refundOverpayment(payment.policyId);
    return;
  }

  // News can arrive out of order: a "processing" notice can be handled after
  // the payment has succeeded. So every write below applies only to a payment
  // that hasn't succeeded, checked in the write itself and not from the copy
  // read above, which may be out of date by now. A completed payment is never
  // downgraded.
  const unlessSucceeded = { id: payment.id, status: { not: "SUCCEEDED" as const } };
  const unlessSucceededOr = (status: "FAILED" | "PENDING") => ({
    id: payment.id,
    status: { notIn: ["SUCCEEDED" as const, status] },
  });

  if (intent.status === "canceled") {
    // Keep the original decline reason if there was one.
    await db.payment.updateMany({
      where: unlessSucceededOr("FAILED"),
      data: { status: "FAILED", failureReason: CANCELLED_NOTE },
    });
  } else if (intent.status === "requires_payment_method" && intent.last_payment_error) {
    await db.payment.updateMany({
      where: unlessSucceeded,
      data: { status: "FAILED", failureReason: intent.last_payment_error.message ?? "The payment was declined." },
    });
  } else if (intent.status === "processing") {
    await db.payment.updateMany({
      where: unlessSucceededOr("PENDING"),
      data: { status: "PENDING", failureReason: null },
    });
  }
}

/** Refunds any credit a payment left behind. A failure here must never undo the payment. */
async function refundOverpayment(policyId: string) {
  try {
    await refundCredit(policyId);
  } catch (error) {
    // The credit stays on the statement, and the broker can use Retry refund.
    console.error("Could not refund a credit after a payment", error);
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

/**
 * Keeps an unfinished payment in step after a broker's change lowers the
 * amount due, so a customer with the payment form open can't pay the old,
 * higher amount.
 *
 *  - Less is due now: the unfinished payment is lowered to the new amount.
 *  - Nothing is due now: the unfinished payment is cancelled.
 *  - More is due now: the payment is left alone. The customer agreed to the
 *    amount on their screen, so we never raise it behind their back. The rest
 *    simply stays due.
 *
 * A payment Stripe is already processing can't be changed. If it clears for
 * too much, the extra is refunded when it succeeds (see recordPaymentIntent).
 */
export async function syncOpenPayments(policyId: string) {
  const open = await db.payment.findMany({
    where: {
      policyId,
      stripePaymentIntentId: { not: null },
      // Not yet submitted, or declined but still open for another try.
      OR: [{ status: "INITIATED" }, { status: "FAILED", failureReason: { notIn: CLOSED_NOTES } }],
    },
  });
  if (open.length === 0) return;

  const due = await balanceCents(policyId);
  for (const p of open) {
    try {
      const intent = await stripe().paymentIntents.retrieve(p.stripePaymentIntentId!, {
        expand: ["payment_method"],
      });
      if (!isUnfinished(intent)) {
        // It has moved on since we last heard (paid, processing, or cancelled).
        await recordPaymentIntent(intent);
        continue;
      }
      if (due <= 0) {
        const cancelled = await stripe().paymentIntents.cancel(intent.id);
        await recordPaymentIntent(cancelled);
        await logIntegrationEvent({
          provider: "stripe",
          direction: "OUTBOUND",
          eventType: "payment_intent.cancel",
          externalId: intent.id,
          policyId,
          payload: { reason: "Nothing is due after a policy change", status: cancelled.status },
        });
      } else if (intent.amount > due) {
        const updated = await stripe().paymentIntents.update(intent.id, { amount: due });
        // A declined attempt keeps the amount the customer actually tried to pay.
        if (p.status === "INITIATED") {
          await db.payment.update({ where: { id: p.id }, data: { amountCents: due } });
        }
        await logIntegrationEvent({
          provider: "stripe",
          direction: "OUTBOUND",
          eventType: "payment_intent.update",
          externalId: intent.id,
          policyId,
          payload: { amount: due, previousAmount: intent.amount, status: updated.status },
        });
      }
    } catch (error) {
      // Best effort. If the old amount is paid after all, the extra is refunded on success.
      console.error("Could not update an open payment after a policy change", error);
    }
  }
}

/** A payment the customer could still complete. */
function isUnfinished(intent: Stripe.PaymentIntent) {
  return (
    intent.status === "requires_payment_method" ||
    intent.status === "requires_confirmation" ||
    intent.status === "requires_action"
  );
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
  // And any refund that was interrupted before we learned what Stripe did with it.
  await sendUnsentRefunds(policyId);
}

/* ------------------------------------------------------------------ */
/* Refunding                                                           */
/* ------------------------------------------------------------------ */

/**
 * If the customer has a credit (they've paid more than they owe), send it
 * back to the payment it came from. Runs after every change to a policy and after every
 * successful payment, and can be re-run by the broker if a refund failed.
 *
 * A credit is first absorbed by anything else owed, simply because the
 * balance is one running total. Only a negative balance is refunded.
 */
export async function refundCredit(
  policyId: string,
  transactionId?: string,
): Promise<{
  /** Refunds Stripe has completed. These are on the statement. */
  refundedCents: number;
  /** Refunds Stripe has accepted but not finished (a bank refund takes days). Not on the statement yet. */
  pendingCents: number;
  message?: string;
}> {
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

  // Send what was just planned, and anything an earlier run was interrupted on.
  const sent = await sendUnsentRefunds(policyId, new Set(planned.rows.map((r) => r.id)));
  let message = sent.message;
  if (planned.shortfallCents > 0) {
    message = `${formatUSD(planned.shortfallCents)} of the credit couldn't be refunded to a card payment.`;
  }
  return { refundedCents: sent.refundedCents, pendingCents: sent.pendingCents, message };
}

/**
 * Sends every refund we have decided on but not yet heard back about: a row
 * that is PENDING with no Stripe refund id.
 *
 * A refund row is written before Stripe is contacted, and that row is the
 * refund from then on. Whatever interrupts the call (the process stopping, or
 * the connection dropping after Stripe accepted it), the same row is sent
 * again with the same idempotency key until its outcome is known, so the
 * credit can be neither stranded nor refunded twice:
 *
 *  - Stripe says yes: the row gets Stripe's refund id and is recorded.
 *  - Stripe says no (a clear rejection): the row is marked failed, and the
 *    credit is free to be refunded again by a new row.
 *  - No answer: the row stays as it is, still holding the credit, and is tried
 *    again the next time the policy is opened or Retry refund is pressed.
 *
 * `fresh` holds the rows planned a moment ago. Any other row is being resumed,
 * so Stripe is first asked whether it already has that refund, which covers a
 * resume after Stripe's idempotency keys have expired (24 hours).
 */
async function sendUnsentRefunds(policyId: string, fresh = new Set<string>()) {
  const rows = await db.refund.findMany({
    where: { policyId, status: "PENDING", stripeRefundId: null },
    include: { payment: true },
    orderBy: { createdAt: "asc" },
  });
  let refundedCents = 0;
  let pendingCents = 0;
  let message: string | undefined;
  for (const row of rows) {
    const paymentIntent = row.payment.stripePaymentIntentId!;
    try {
      const existing = fresh.has(row.id) ? null : await findStripeRefund(paymentIntent, row.id);
      const refund =
        existing ??
        (await stripe().refunds.create(
          {
            payment_intent: paymentIntent,
            amount: row.amountCents,
            reason: "requested_by_customer",
            metadata: { refundId: row.id, policyId },
          },
          { idempotencyKey: `refund-${row.id}` },
        ));
      const saved = await db.refund.updateMany({
        where: { id: row.id, stripeRefundId: null },
        data: { stripeRefundId: refund.id, failureReason: null },
      });
      if (saved.count === 1) {
        await logIntegrationEvent({
          provider: "stripe",
          direction: "OUTBOUND",
          eventType: existing ? "refund.resume" : "refund.create",
          externalId: refund.id,
          policyId,
          payload: { amount: refund.amount, status: refund.status, payment_intent: paymentIntent, metadata: refund.metadata },
        });
      }
      await recordRefund(refund);
      // Only a refund Stripe has completed counts as refunded. One it is still working on is pending.
      if (refund.status === "succeeded") refundedCents += row.amountCents;
      else if (refund.status === "pending" || refund.status === "requires_action") pendingCents += row.amountCents;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Stripe rejected the refund.";
      if (isRejection(error)) {
        await db.refund.update({ where: { id: row.id }, data: { status: "FAILED", failureReason: reason } });
        message = `A refund of ${formatUSD(row.amountCents)} failed: ${reason}`;
      } else {
        // We don't know whether Stripe made the refund. Keep the row, and its hold on the credit.
        await db.refund.update({
          where: { id: row.id },
          data: { failureReason: "Waiting to hear from Stripe. This refund is checked again automatically." },
        });
        message = `A refund of ${formatUSD(row.amountCents)} couldn't be confirmed with Stripe yet. It will be checked again automatically and can't be sent twice.`;
      }
      await logIntegrationEvent({
        provider: "stripe",
        direction: "OUTBOUND",
        eventType: isRejection(error) ? "refund.create.failed" : "refund.create.unconfirmed",
        policyId,
        payload: { refundId: row.id, amount: row.amountCents, error: reason },
      });
    }
  }
  return { refundedCents, pendingCents, message };
}

/**
 * True when Stripe answered and refused: the request was invalid, or the
 * payment can't be refunded. Anything else (no connection, a timeout, a
 * server error, a clash with the same request still in flight) leaves the
 * outcome unknown.
 */
function isRejection(error: unknown) {
  return error instanceof Stripe.errors.StripeInvalidRequestError || error instanceof Stripe.errors.StripeCardError;
}

/** Looks for a refund Stripe already made for one of our refund rows. */
async function findStripeRefund(paymentIntent: string, refundRowId: string) {
  const made = await stripe().refunds.list({ payment_intent: paymentIntent, limit: 100 });
  return made.data.find((r) => r.metadata?.refundId === refundRowId) ?? null;
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
