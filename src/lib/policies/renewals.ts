import "server-only";
import { db } from "@/lib/db";
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
import { issuePolicy } from "./service";

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
};

async function planRenewal(policyId: string): Promise<RenewalPreview> {
  const policy = await db.policy.findUnique({
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
  return {
    startDate: state.endDate,
    endDate: addOneYear(state.endDate),
    coverages,
    premiumCents: coverages.reduce((sum, c) => sum + c.annualPremiumCents, 0),
  };
}

export const previewRenewal = planRenewal;

export async function renewPolicy(policyId: string, userId: string) {
  const plan = await planRenewal(policyId);
  const policy = await db.policy.findUniqueOrThrow({ where: { id: policyId } });
  try {
    return await issuePolicy({
      customerId: policy.customerId,
      startDate: plan.startDate,
      coverageCodes: plan.coverages.map((c) => c.code),
      userId,
      renewedFromId: policy.id,
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
