import type { ISODate } from "./dates";
import type { CoverageInterval, PolicyState } from "./types";

/* ------------------------------------------------------------------ */
/* Broker commission                                                   */
/* ------------------------------------------------------------------ */

/**
 * Commission on one premium line: amount × rate, rounded to the cent with
 * halves away from zero. A credit or reversal gives a negative commission
 * (a clawback) of exactly the size the original charge earned, so reversing
 * a line always reverses its commission to the cent.
 */
export function commissionFor(premiumCents: number, rateBps: number): number {
  if (!Number.isInteger(premiumCents)) throw new Error("Premium must be a whole number of cents");
  if (!Number.isInteger(rateBps) || rateBps < 0) throw new Error("Rate must be whole basis points, 0 or more");
  const magnitude = Math.floor((2 * Math.abs(premiumCents) * rateBps + 10_000) / 20_000);
  return premiumCents < 0 ? -magnitude : magnitude;
}

/** "10%" from 1000, "7.5%" from 750. */
export function formatRate(rateBps: number): string {
  return `${rateBps / 100}%`;
}

/* ------------------------------------------------------------------ */
/* Claims                                                              */
/* ------------------------------------------------------------------ */

/**
 * What a claim pays: the approved loss, less the deductible, capped at the
 * coverage's per-claim limit. Never below zero.
 */
export function claimPayout(approvedLossCents: number, deductibleCents: number, limitCents: number): number {
  for (const n of [approvedLossCents, deductibleCents, limitCents]) {
    if (!Number.isInteger(n) || n < 0) throw new Error("Amounts must be whole, non-negative cents");
  }
  return Math.min(Math.max(approvedLossCents - deductibleCents, 0), limitCents);
}

/** Whether a coverage was in force on the day of a loss, given the policy as it stands now. */
export function isCoveredOn(state: PolicyState, coverageCode: string, lossDate: ISODate): boolean {
  return state.intervals.some((i) => i.code === coverageCode && i.from <= lossDate && lossDate < i.to);
}

/* ------------------------------------------------------------------ */
/* Renewals                                                            */
/* ------------------------------------------------------------------ */

/**
 * The coverages a renewal carries forward: whatever is in force on the last
 * day of the expiring term. A coverage removed mid-term isn't renewed; one
 * added mid-term is.
 */
export function coveragesToRenew(state: PolicyState): CoverageInterval[] {
  return state.intervals.filter((i) => i.to === state.endDate);
}
