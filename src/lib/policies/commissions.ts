import "server-only";
import { db } from "@/lib/db";
import { commissionFor } from "@/lib/engine";

/**
 * Broker commission.
 *
 * Commission isn't stored. It is worked out from the premium lines on each
 * policy's statement, at the rate fixed on the policy when it was issued:
 *
 *     commission on a line = premium on that line × rate
 *
 * So every dollar of commission points at the statement line it came from,
 * and it can never disagree with the statement. A credit or reversal earns
 * negative commission: when premium is returned to the customer, the
 * commission on it is clawed back. Payments and refunds earn nothing, since
 * they move money without changing the premium.
 *
 * Simplification: commission is earned when premium is charged, not when it
 * is collected, and paying the broker isn't modelled.
 */

export type CommissionLine = {
  entryId: string;
  /** Line number on the policy's statement. */
  statementLine: number;
  description: string;
  kind: "CHARGE" | "CREDIT" | "REVERSAL";
  premiumCents: number;
  commissionCents: number;
};

export type PolicyCommission = {
  policyId: string;
  policyNumber: string;
  businessName: string;
  rateBps: number;
  premiumCents: number;
  commissionCents: number;
  lines: CommissionLine[];
};

const PREMIUM_KINDS = new Set(["CHARGE", "CREDIT", "REVERSAL"]);

type PolicyWithLedger = {
  id: string;
  policyNumber: string;
  commissionRateBps: number;
  customer: { businessName: string };
  ledger: { id: string; kind: string; amountCents: number; description: string }[];
};

function commissionOf(policy: PolicyWithLedger): PolicyCommission {
  const lines: CommissionLine[] = [];
  policy.ledger.forEach((entry, index) => {
    if (!PREMIUM_KINDS.has(entry.kind)) return;
    lines.push({
      entryId: entry.id,
      statementLine: index + 1,
      description: entry.description,
      kind: entry.kind as CommissionLine["kind"],
      premiumCents: entry.amountCents,
      commissionCents: commissionFor(entry.amountCents, policy.commissionRateBps),
    });
  });
  return {
    policyId: policy.id,
    policyNumber: policy.policyNumber,
    businessName: policy.customer.businessName,
    rateBps: policy.commissionRateBps,
    premiumCents: lines.reduce((s, l) => s + l.premiumCents, 0),
    commissionCents: lines.reduce((s, l) => s + l.commissionCents, 0),
    lines,
  };
}

const include = {
  customer: { select: { businessName: true } },
  ledger: { orderBy: { seq: "asc" as const } },
};

export async function commissionForPolicy(policyId: string): Promise<PolicyCommission | null> {
  const policy = await db.policy.findUnique({ where: { id: policyId }, include });
  return policy ? commissionOf(policy) : null;
}

export async function commissionForAllPolicies(): Promise<PolicyCommission[]> {
  const policies = await db.policy.findMany({ orderBy: { createdAt: "asc" }, include });
  return policies.map(commissionOf);
}
