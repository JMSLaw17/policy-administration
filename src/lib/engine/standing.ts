import { formatDate, type ISODate } from "./dates";

/**
 * Where a policy stands on a given day, worked out from its dates.
 *
 * The record of a policy says whether a cancellation has been entered, not
 * whether it has taken effect: a cancellation dated next month is on record
 * today, but the policy still covers the customer until then. And a term that
 * has run out is over even though nobody cancelled it. So what is shown to
 * people is derived from the dates, the same dates the coverage table uses,
 * and the two can't disagree.
 */
export type PolicyStanding = {
  kind: "UPCOMING" | "ACTIVE" | "CANCELLED" | "EXPIRED";
  /** A cancellation that is on record but hasn't taken effect yet. */
  cancelsOn: ISODate | null;
};

export function policyStanding(
  policy: { startDate: ISODate; endDate: ISODate; cancelledEffective: ISODate | null },
  today: ISODate,
): PolicyStanding {
  const { startDate, endDate, cancelledEffective } = policy;
  // Cancelled once the cancellation date arrives. Cancelled from the first day, it never covered anything.
  if (cancelledEffective && (cancelledEffective <= today || cancelledEffective <= startDate)) {
    return { kind: "CANCELLED", cancelsOn: null };
  }
  // A cancellation dated on the last day of the term changes nothing: the term ends then anyway.
  const cancelsOn = cancelledEffective && cancelledEffective < endDate ? cancelledEffective : null;
  if (today < startDate) return { kind: "UPCOMING", cancelsOn };
  if (today >= endDate) return { kind: "EXPIRED", cancelsOn: null };
  return { kind: "ACTIVE", cancelsOn };
}

/** A few words for a list, such as "cancelled" or "cancels Dec 1, 2026". Empty for a policy simply in force. */
export function standingNote(standing: PolicyStanding, startDate: ISODate): string {
  if (standing.kind === "CANCELLED") return "cancelled";
  if (standing.kind === "EXPIRED") return "expired";
  if (standing.cancelsOn) return `cancels ${formatDate(standing.cancelsOn)}`;
  if (standing.kind === "UPCOMING") return `starts ${formatDate(startDate)}`;
  return "";
}
