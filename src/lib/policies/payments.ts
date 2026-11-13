import "server-only";
import Stripe from "stripe";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { allocateRefund, formatUSD, isBelowMinimumPayment, MIN_PAYMENT_CENTS } from "@/lib/engine";
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

/**
 * Checkout wasn't started because nothing is due: the policy is paid, or the
 * app has just found out that an earlier payment went through. Not a failure.
 * The page that asked is out of date and should show the policy as paid.
 */
export class AlreadyPaidError extends PaymentError {}

const CANCELLED_NOTE = "The payment was cancelled.";
const SUPERSEDED_NOTE = "Not submitted. Closed when the amount due changed.";
/** Reasons that mean an attempt is closed for good, as opposed to declined and open for another try. */
const RETURNED_NOTE = "Returned by the bank after it had cleared.";
const CLOSED_NOTES = [CANCELLED_NOTE, SUPERSEDED_NOTE, RETURNED_NOTE];

/**
 * Attempts that were declined and whose payment form can, as far as we know,
 * still be retried: Stripe hasn't yet confirmed them cancelled. While a policy
 * has one of these, no other attempt may be created for it, because both
 * could collect.
 */
const declinedAndStillOpen = (policyId: string) => ({
  policyId,
  status: "FAILED" as const,
  stripePaymentIntentId: { not: null },
  closedAt: null,
  failureReason: { notIn: CLOSED_NOTES },
});

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
    // First find out what became of any earlier attempt that was declined. The amount due
    // is only worked out, and a new attempt only offered, once that is known.
    await settleDeclinedAttempts(policyId);
    const reserved = await reserveAttempt(policyId);
    // A decline was recorded in the moment since the check above. Go round and settle it first.
    if (!reserved) continue;
    const { payment } = reserved;

    const intent = payment.stripePaymentIntentId
      ? await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId)
      : await createIntent(payment);

    if (intent.status === "processing") {
      throw new PaymentError("A payment is already being processed. It can take a little while to clear.");
    }
    if (isUnfinished(intent) && !intent.last_payment_error) {
      // The amount due is read again here, after the attempt has its PaymentIntent on record,
      // and only then is checkout handed to the customer. A change to the policy made while
      // the PaymentIntent was being created couldn't see it to close it. From this point any
      // later change can, because the link is saved. So between this check and those, no
      // attempt for an out-of-date amount gets through.
      const due = await balanceCents(policyId);
      if (intent.amount === due) return { clientSecret: intent.client_secret!, amountCents: intent.amount };
      // A PaymentIntent's amount is never changed. This one is closed, and the next pass makes a new one.
      await closeOutdated(payment, intent, due);
      continue;
    }

    // Succeeded, failed, or cancelled: record it, which closes the attempt, and start fresh.
    await recordPaymentIntent(intent);
    await db.payment.updateMany({
      where: { id: payment.id, status: "INITIATED" },
      data: { status: "FAILED", failureReason: intent.last_payment_error?.message ?? CANCELLED_NOTE },
    });
    if ((await balanceCents(policyId)) <= 0) throw new AlreadyPaidError("This policy has just been paid, so nothing more is due.");
  }
  throw new PaymentError("We couldn't start the payment. Nothing was charged. Please try again.");
}

/**
 * Finds the policy's open attempt, or creates one for the amount due. Runs
 * under a lock on the policy, so concurrent requests get the same attempt.
 *
 * A new attempt is only created if no earlier one can still collect, and that
 * is checked here, under the same lock a decline is recorded under. Checking
 * only beforehand leaves a gap: a decline recorded in between would be
 * missed, a second attempt created, and the first form retried, so both take
 * the money. If there is such an attempt, nothing is created and null is
 * returned, for the caller to settle it and come back.
 */
async function reserveAttempt(policyId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Policy" WHERE id = ${policyId} FOR UPDATE`;
    const sum = await tx.ledgerEntry.aggregate({ where: { policyId }, _sum: { amountCents: true } });
    const due = sum._sum.amountCents ?? 0;
    if (due <= 0) throw new AlreadyPaidError("Nothing is due on this policy.");
    if (isBelowMinimumPayment(due)) {
      throw new PaymentError(
        `${formatUSD(due)} is less than ${formatUSD(MIN_PAYMENT_CENTS)}, the smallest amount that can be collected. It stays on the statement and will be added to the next payment.`,
      );
    }

    const open = await tx.payment.findFirst({
      where: { policyId, status: { in: ["INITIATED", "PENDING"] } },
      orderBy: { createdAt: "desc" },
    });
    if (open) return { payment: open, due };
    if (await tx.payment.count({ where: declinedAndStillOpen(policyId) })) return null;
    return { payment: await tx.payment.create({ data: { policyId, amountCents: due } }), due };
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
 * A declined card leaves its payment form open, and the customer can try again
 * on it. So a declined attempt isn't over until Stripe says so, and before a
 * new attempt is offered each one is settled:
 *
 *  - It was paid after all (a retry on the same form went through, and the
 *    news hasn't reached us yet): the payment is recorded now, so the amount
 *    due is worked out with it counted. Without this, a second checkout could
 *    collect the same balance again.
 *  - Stripe is still processing it: no new attempt until it settles.
 *  - It is still open: it is cancelled at Stripe, so it can never be completed
 *    on top of the new attempt. If the cancellation can't be confirmed, no
 *    new attempt is offered, because the old one might still take the money.
 *
 * A failed attempt keeps its own record throughout.
 */
async function settleDeclinedAttempts(policyId: string) {
  const declined = await db.payment.findMany({ where: declinedAndStillOpen(policyId) });
  const read = (id: string) => stripe().paymentIntents.retrieve(id, { expand: ["payment_method"] });
  for (const attempt of declined) {
    let intent = await read(attempt.stripePaymentIntentId!);
    if (isUnfinished(intent)) {
      try {
        intent = await stripe().paymentIntents.cancel(intent.id);
      } catch {
        // Stripe refuses to cancel a payment that has just gone through. Look again.
        intent = await read(intent.id);
        if (isUnfinished(intent)) {
          throw new PaymentError(
            "We couldn't close your earlier payment attempt, so a new one wasn't started. Nothing was charged. Please try again in a moment.",
          );
        }
      }
    }
    // Paid, being processed, or cancelled: record which.
    await recordPaymentIntent(intent);
    if (intent.status === "canceled") {
      // Stripe has confirmed it can no longer collect. It keeps its decline reason.
      await db.payment.updateMany({ where: { id: attempt.id, status: "FAILED" }, data: { closedAt: new Date() } });
    }
    if (intent.status === "processing") {
      throw new PaymentError("A payment is already being processed. It can take a little while to clear.");
    }
    if (intent.status === "succeeded" && (await balanceCents(policyId)) <= 0) {
      throw new AlreadyPaidError("Your earlier payment went through, so nothing more is due.");
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
      // A payment the bank took back in full stays returned. Stripe still calls
      // the PaymentIntent "succeeded", and hearing that again changes nothing.
      // This is judged from the amounts on the statement, not from the status
      // or its wording, which older news could have overwritten.
      if (await keepReturned(tx, payment.id)) return;
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
      // If the bank's return was heard about before the payment itself, it has
      // been waiting for this line. Put it on the statement now.
      await postReturns(tx, payment.id);
    });
    // The amount due can drop while a payment is clearing (a bank debit takes
    // days). If this payment left the customer in credit, send the extra back
    // now rather than waiting for the broker's next change.
    await refundOverpayment(payment.policyId);
    return;
  }

  // News can arrive out of order: a "processing", "declined" or "cancelled"
  // notice can be handled after the payment has settled. A payment that is on
  // the statement has settled, whatever has happened to it since (it stands,
  // or the bank took it back), so news like that is out of date and changes
  // nothing. This is checked under the policy lock, against the statement
  // itself, and not from the copy read above.
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Policy" WHERE id = ${payment.policyId} FOR UPDATE`;
    if (await tx.ledgerEntry.findUnique({ where: { paymentId: payment.id } })) {
      await keepReturned(tx, payment.id);
      return;
    }
    const unlessSucceeded = { id: payment.id, status: { not: "SUCCEEDED" as const } };
    const unlessSucceededOr = (status: "FAILED" | "PENDING") => ({
      id: payment.id,
      status: { notIn: ["SUCCEEDED" as const, status] },
    });

    if (intent.status === "canceled") {
      // Keep the original decline reason if there was one.
      await tx.payment.updateMany({
        where: unlessSucceededOr("FAILED"),
        data: { status: "FAILED", failureReason: CANCELLED_NOTE },
      });
    } else if (intent.status === "requires_payment_method" && intent.last_payment_error) {
      await tx.payment.updateMany({
        where: unlessSucceeded,
        data: { status: "FAILED", failureReason: intent.last_payment_error.message ?? "The payment was declined." },
      });
    } else if (intent.status === "processing") {
      await tx.payment.updateMany({
        where: unlessSucceededOr("PENDING"),
        data: { status: "PENDING", failureReason: null },
      });
    }
  });
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
 * After a change to a policy, closes any open payment that is for more than
 * is now due, so a customer with the payment form open can't pay the old,
 * higher amount. Opening checkout again starts a new payment for the new
 * amount.
 *
 *  - Less is due now, or nothing, or too little to collect: the open payment
 *    is cancelled at Stripe.
 *  - More is due now: the payment is left alone. The customer agreed to the
 *    amount on their screen, and the rest simply stays due.
 *
 * A PaymentIntent's amount is never changed after it is created. Changing it
 * means sending Stripe a new figure, and two such requests can arrive in
 * either order, however carefully they were sent: the one for an earlier
 * change could land last and put the payment back up above what is due. A
 * cancellation has no such problem. It can't be undone by anything that
 * arrives late, and cancelling twice is the same as cancelling once.
 *
 * A payment Stripe is already processing can't be cancelled. If it clears for
 * too much, the extra is refunded when it succeeds (see recordPaymentIntent).
 */
export async function syncOpenPayments(policyId: string) {
  const open = await db.payment.findMany({
    where: {
      policyId,
      stripePaymentIntentId: { not: null },
      // Not yet submitted, or declined but still open for another try.
      OR: [{ status: "INITIATED" }, { status: "FAILED", closedAt: null, failureReason: { notIn: CLOSED_NOTES } }],
    },
  });
  for (const payment of open) {
    try {
      const intent = await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId!, { expand: ["payment_method"] });
      if (!isUnfinished(intent)) {
        // It has moved on since we last heard (paid, processing, or cancelled).
        await recordPaymentIntent(intent);
        continue;
      }
      // Read after the change that called us was saved, so the last change to a policy always
      // judges its open payments against the final balance.
      const due = await balanceCents(policyId);
      if (intent.amount > due || isBelowMinimumPayment(due)) await closeOutdated(payment, intent, due);
    } catch (error) {
      // Best effort. If the old amount is paid after all, the extra is refunded on success.
      console.error("Could not close an open payment after a policy change", error);
    }
  }
}

/**
 * Cancels a payment whose amount is no longer the amount due, and marks it
 * closed once Stripe confirms. If Stripe won't cancel it because it has just
 * been paid or submitted, that outcome is recorded instead. If the
 * cancellation can't be confirmed either way, this throws, and no
 * replacement is offered.
 */
async function closeOutdated(
  payment: { id: string; policyId: string; status: string },
  intent: Stripe.PaymentIntent,
  due: number,
) {
  let closed: Stripe.PaymentIntent;
  try {
    closed = await stripe().paymentIntents.cancel(intent.id);
  } catch (error) {
    const now = await stripe().paymentIntents.retrieve(intent.id, { expand: ["payment_method"] });
    if (isUnfinished(now)) throw error;
    closed = now;
  }
  if (closed.status !== "canceled") {
    await recordPaymentIntent(closed);
    return;
  }
  // An attempt the customer never submitted is marked as replaced. A declined one keeps its reason.
  await db.payment.updateMany({
    where: { id: payment.id, status: "INITIATED" },
    data: { status: "FAILED", failureReason: due <= 0 ? CANCELLED_NOTE : SUPERSEDED_NOTE, closedAt: new Date() },
  });
  await db.payment.updateMany({ where: { id: payment.id, status: "FAILED", closedAt: null }, data: { closedAt: new Date() } });
  await logIntegrationEvent({
    provider: "stripe",
    direction: "OUTBOUND",
    eventType: "payment_intent.cancel",
    externalId: intent.id,
    policyId: payment.policyId,
    payload: {
      reason:
        due <= 0
          ? "Nothing is due after a policy change"
          : isBelowMinimumPayment(due)
            ? "The amount due is now too small to collect"
            : "The amount due changed, so this payment was closed",
      amount: intent.amount,
      due,
      status: closed.status,
    },
  });
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
      include: { refunds: { where: { status: { not: "FAILED" } } }, returns: { include: { ledgerEntry: true } } },
    });
    const { allocations, shortfallCents } = allocateRefund(
      credit,
      payments.map((p) => ({
        paymentId: p.id,
        amountCents: p.amountCents,
        // Money the bank has taken back is no longer there to refund, any more than money already refunded.
        alreadyRefundedCents:
          p.refunds.reduce((s, r) => s + r.amountCents, 0) +
          p.returns.reduce((s, r) => s + (r.ledgerEntry?.amountCents ?? 0), 0),
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
      // Read again under the lock. A refund Stripe has reported as failed never
      // succeeds afterwards, so a "succeeded" that turns up late (an answer that
      // was slow to arrive, or old news) must not undo the failure and wipe out
      // the credit the customer is still owed.
      const current = await tx.refund.findUniqueOrThrow({ where: { id: row.id } });
      if (current.status === "FAILED") return;
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
    const reason = refundFailureText(refund);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Policy" WHERE id = ${row.policyId} FOR UPDATE`;
      // Stripe can report a refund as succeeded and change it to failed days
      // later, when the customer's bank turns it away. By then the refund is on
      // the statement. That line is kept, and a second line cancels it out, so
      // the statement shows what happened and the customer is in credit again.
      // The second line points at the first, and a line can be reversed only
      // once, so hearing about the failure again posts nothing.
      const posted = await tx.ledgerEntry.findUnique({ where: { refundId: row.id }, include: { reversedBy: true } });
      if (posted && !posted.reversedBy) {
        await tx.ledgerEntry.create({
          data: {
            policyId: row.policyId,
            kind: "REFUND",
            amountCents: -posted.amountCents,
            description: `Refund failed and was not paid out: ${reason}`,
            reversesEntryId: posted.id,
            postedByTransactionId: row.transactionId,
          },
        });
      }
      await tx.refund.update({ where: { id: row.id }, data: { status: "FAILED", failureReason: reason } });
    });
  }
}

/** Why Stripe says a refund failed, in a sentence. */
function refundFailureText(refund: Stripe.Refund) {
  const reasons: Record<string, string> = {
    expired_or_canceled_card: "The card it was going back to has expired or been cancelled.",
    lost_or_stolen_card: "The card it was going back to was reported lost or stolen.",
    charge_for_pending_refund_disputed: "The original payment was disputed while the refund was on its way.",
    insufficient_funds: "There weren't enough funds in the Stripe account to send it.",
    declined: "The customer's bank declined it.",
    merchant_request: "It was cancelled at the merchant's request.",
  };
  return reasons[refund.failure_reason ?? ""] ?? "The customer's bank or card issuer did not accept it.";
}

/* ------------------------------------------------------------------ */
/* Payments taken back by the customer's bank                          */
/* ------------------------------------------------------------------ */

/**
 * A payment can be taken back after it has cleared. A bank debit can be
 * returned by the customer's bank days later (not enough money, the account
 * closed, the debit not authorised), and a card payment can be charged back.
 * Stripe reports both as a dispute on the payment.
 *
 * Once the dispute is lost the money is gone for good (a returned bank debit
 * is lost from the start and can't be contested). The payment's line stays on
 * the statement and a new line puts the amount back, so it is due again.
 *
 * Each dispute is saved as its own record, keyed by Stripe's dispute id:
 *
 *  - Hearing about the same dispute twice finds the record and adds nothing.
 *  - Two disputes on one payment (two partial chargebacks) are two records,
 *    and both count.
 *  - News can arrive out of order. If the return is heard about before the
 *    payment itself is on the statement, the record is kept and its line is
 *    posted when the payment is recorded (see recordPaymentIntent). Stripe is
 *    also asked about the payment straight away, so that is usually at once.
 *
 * Not handled: a card dispute that is still open (the money has left the
 * account but may come back), and a refund already sent against the payment.
 */
export async function recordDispute(dispute: Stripe.Dispute) {
  const intentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!intentId || dispute.status !== "lost") return;
  const payment = await db.payment.findUnique({ where: { stripePaymentIntentId: intentId } });
  if (!payment) return;

  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Policy" WHERE id = ${payment.policyId} FOR UPDATE`;
    const known = await tx.paymentReturn.findUnique({ where: { stripeDisputeId: dispute.id } });
    if (!known) {
      await tx.paymentReturn.create({
        data: {
          policyId: payment.policyId,
          paymentId: payment.id,
          amountCents: dispute.amount,
          reason: dispute.reason,
          stripeDisputeId: dispute.id,
        },
      });
    }
    await postReturns(tx, payment.id);
  });

  // If the payment isn't on the statement yet, we heard about the return
  // first. Ask Stripe about the payment now. Recording it posts the return too.
  const posted = await db.ledgerEntry.findUnique({ where: { paymentId: payment.id } });
  if (!posted) {
    try {
      await recordPaymentIntent(await stripe().paymentIntents.retrieve(intentId, { expand: ["payment_method"] }));
    } catch (error) {
      // The return is saved, and is posted whenever the payment is next recorded.
      console.error("Could not check a disputed payment with Stripe", error);
    }
  }
}

/**
 * How much of a payment the bank has taken back. Null if the payment isn't on
 * the statement yet.
 *
 * There is one source for returned money: the statement lines linked to a
 * PaymentReturn record. The statement, the payment's status, and how much of
 * the payment is left to refund all read the amounts posted on those lines.
 */
async function returnedSoFar(tx: Prisma.TransactionClient, paymentId: string) {
  const paid = await tx.ledgerEntry.findUnique({ where: { paymentId } });
  if (!paid) return null;
  const returned = await tx.ledgerEntry.aggregate({
    where: { paymentReturn: { paymentId } },
    _sum: { amountCents: true },
  });
  // The payment line is negative.
  return { paidCents: -paid.amountCents, returnedCents: returned._sum.amountCents ?? 0 };
}

/**
 * If the bank has taken a payment back in full, makes sure it is marked as
 * returned and says so. A payment taken back in full is no longer a payment,
 * whatever Stripe goes on to say about the PaymentIntent.
 */
async function keepReturned(tx: Prisma.TransactionClient, paymentId: string) {
  const sums = await returnedSoFar(tx, paymentId);
  if (!sums || sums.returnedCents < sums.paidCents) return false;
  await tx.payment.update({ where: { id: paymentId }, data: { status: "FAILED", failureReason: RETURNED_NOTE } });
  return true;
}

/**
 * Puts on the statement any of a payment's returns that aren't there yet.
 * Does nothing until the payment itself is on the statement, because there is
 * nothing to take back before then. Runs under the caller's lock on the policy.
 */
async function postReturns(tx: Prisma.TransactionClient, paymentId: string) {
  const sums = await returnedSoFar(tx, paymentId);
  if (!sums) return;
  const returns = await tx.paymentReturn.findMany({
    where: { paymentId, ledgerEntry: null },
    orderBy: { createdAt: "asc" },
  });
  // What the bank takes back can never be more than was paid.
  let left = sums.paidCents - sums.returnedCents;
  for (const r of returns) {
    const amountCents = Math.min(r.amountCents, left);
    if (amountCents <= 0) continue;
    await tx.ledgerEntry.create({
      data: {
        policyId: r.policyId,
        kind: "PAYMENT",
        amountCents,
        description: `Payment returned by the bank (${r.reason.replaceAll("_", " ")})`,
        paymentReturnId: r.id,
      },
    });
    left -= amountCents;
  }
  // A payment taken back in full is no longer a payment. One taken back in part still is.
  await keepReturned(tx, paymentId);
}
