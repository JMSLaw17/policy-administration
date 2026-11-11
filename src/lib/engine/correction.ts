import type { PremiumLine } from "./types";

/** A premium line that is already on the statement. */
export type PostedLine = PremiumLine & { entryId: string };

export type CorrectionPlan = {
  /** Statement entries that are no longer right. Each gets a reversal entry. */
  toReverse: PostedLine[];
  /** New lines to post in their place. */
  toPost: PremiumLine[];
  /** Net change in what the customer owes. Positive means they owe more. */
  netChangeCents: number;
};

const key = (l: PremiumLine) =>
  [l.eventId, l.coverageCode, l.kind, l.amountCents, l.annualPremiumCents, l.from, l.to].join("|");

/**
 * Compares what is on the statement now with what should be there after a
 * correction, and returns the smallest set of reversals and new lines that
 * gets from one to the other.
 *
 * Nothing on the statement is edited or deleted. A wrong line is cancelled out
 * by a reversal for the same amount with the opposite sign, and the right line
 * is posted next to it, so both the original and the correction stay visible.
 * Lines that the correction doesn't affect are left alone.
 */
export function planCorrection(current: PostedLine[], corrected: PremiumLine[]): CorrectionPlan {
  // Match identical lines one-for-one; whatever is left over on each side differs.
  const unmatched = new Map<string, PremiumLine[]>();
  for (const l of corrected) {
    const k = key(l);
    unmatched.set(k, [...(unmatched.get(k) ?? []), l]);
  }

  const toReverse: PostedLine[] = [];
  for (const posted of current) {
    const matches = unmatched.get(key(posted));
    if (matches?.length) matches.pop();
    else toReverse.push(posted);
  }
  const toPost = corrected.filter((l) => {
    const left = unmatched.get(key(l));
    if (left?.length) {
      left.pop();
      return true;
    }
    return false;
  });

  const netChangeCents =
    toPost.reduce((s, l) => s + l.amountCents, 0) - toReverse.reduce((s, l) => s + l.amountCents, 0);

  return { toReverse, toPost, netChangeCents };
}
