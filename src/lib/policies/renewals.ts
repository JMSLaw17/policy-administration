import "server-only";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  addOneYear,
  coveragesToRenew,
  formatDate,
  getCoverage,
  PolicyRuleError,
  replay,
  type ISODate,
} from "@/lib/engine";
import { buildSlots, toHistory } from "./history";
import { issuePolicyIn, lockChain } from "./service";

/**
 * Renewal: a new policy for the 12 months after the current term ends.
 *
 *  - It carries forward the coverages in force on the last day of the term.
 *  - It is priced from today's rate table, not the expiring policy's prices.
 *  - It is a separate policy with its own number, statement, and payments, so
 *    each term's money stays traceable on its own. The two are linked.
 *  - It is on the same terms the customer already signed for, so it doesn't
 *    need a new application.
 */

export type RenewalPreview = {
  startDate: ISODate;
  endDate: ISODate;
  coverages: { code: string; annualPremiumCents: number; previousAnnualPremiumCents: number }[];
  premiumCents: number;
  /**
   * The renewal's terms as one string. The broker's click sends it back, and
   * the renewal is only created if the terms are still these.
   */
  fingerprint: string;
};

/** Thrown when the renewal the broker was shown is no longer the one that would be created. */
export class RenewalChangedError extends PolicyRuleError {
  constructor() {
    super(
      "This policy has changed since the renewal was shown, so the renewal would be different now. Nothing was created. Check the new term and premium, and renew again.",
    );
  }
}

async function planRenewal(client: Prisma.TransactionClient, policyId: string): Promise<RenewalPreview> {
  const policy = await client.policy.findUnique({
    where: { id: policyId },
    include: { transactions: { orderBy: { seq: "asc" } }, renewal: { select: { policyNumber: true } } },
  });
  if (!policy) throw new PolicyRuleError("Policy not found.");
  if (policy.renewal) {
    throw new PolicyRuleError(`This policy has already been renewed as ${policy.renewal.policyNumber}.`);
  }
  const state = replay(toHistory(buildSlots(policy.transactions)));
  if (state.cancelledEffective) {
    throw new PolicyRuleError(
      `This policy was cancelled effective ${formatDate(state.cancelledEffective)}, so it can't be renewed.`,
    );
  }
  const coverages = coveragesToRenew(state).map((c) => ({
    code: c.code,
    annualPremiumCents: getCoverage(c.code).annualPremiumCents,
    previousAnnualPremiumCents: c.annualPremiumCents,
  }));
  const startDate = state.endDate;
  const endDate = addOneYear(state.endDate);
  const premiumCents = coverages.reduce((sum, c) => sum + c.annualPremiumCents, 0);
  return {
    startDate,
    endDate,
    coverages,
    premiumCents,
    fingerprint: JSON.stringify([startDate, endDate, coverages.map((c) => [c.code, c.annualPremiumCents]), premiumCents]),
  };
}

export const previewRenewal = (policyId: string) => planRenewal(db, policyId);

/**
 * Creates the renewal. `previewed` is the fingerprint of the renewal the
 * broker was shown. The renewal is worked out again under a lock on the
 * policy, and if a change to the expiring policy has made it different (a
 * coverage added or removed, or the dates corrected), nothing is created and
 * the broker is asked to look again.
 */
export async function renewPolicy(policyId: string, userId: string, previewed?: string) {
  try {
    return await db.$transaction(async (tx) => {
      // The same lock a change to the policy takes, so the two can't interleave.
      await lockChain(tx, policyId);
      const plan = await planRenewal(tx, policyId);
      if (previewed !== undefined && previewed !== plan.fingerprint) throw new RenewalChangedError();
      const policy = await tx.policy.findUniqueOrThrow({ where: { id: policyId } });
      return issuePolicyIn(tx, {
        customerId: policy.customerId,
        startDate: plan.startDate,
        coverageCodes: plan.coverages.map((c) => c.code),
        userId,
        renewedFromId: policy.id,
      });
    });
  } catch (error) {
    // The unique link stops two renewals of one policy, even if two brokers click at once.
    if (isUniqueViolation(error)) throw new PolicyRuleError("This policy has already been renewed.");
    throw error;
  }
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}
