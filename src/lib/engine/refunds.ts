/** A successful payment and how much of it has already been refunded. */
export type RefundablePayment = {
  paymentId: string;
  amountCents: number;
  alreadyRefundedCents: number;
  /** Used to refund the most recent payment first. */
  paidAt: Date;
};

export type RefundAllocation = { paymentId: string; amountCents: number };

/**
 * Decides which card payments a refund comes out of.
 *
 * A card refund has to go back against a specific payment, and can't exceed
 * what's left of it. We refund the newest payment first and work backwards.
 * If the customer is owed more than they ever paid by card (which shouldn't
 * happen), `shortfallCents` says how much couldn't be refunded this way.
 */
export function allocateRefund(
  amountCents: number,
  payments: RefundablePayment[],
): { allocations: RefundAllocation[]; shortfallCents: number } {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new Error("Refund amount must be a whole, non-negative number of cents");
  }
  let remaining = amountCents;
  const allocations: RefundAllocation[] = [];
  const newestFirst = [...payments].sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime());

  for (const p of newestFirst) {
    if (remaining === 0) break;
    const available = p.amountCents - p.alreadyRefundedCents;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    allocations.push({ paymentId: p.paymentId, amountCents: take });
    remaining -= take;
  }
  return { allocations, shortfallCents: remaining };
}
