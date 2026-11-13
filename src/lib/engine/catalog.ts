/**
 * The one product we sell, with a flat annual premium per coverage.
 * Simplification: no rating factors (industry, revenue, chosen limits), taxes, or fees.
 * Each coverage has one fixed per-claim limit, and every claim has the same deductible.
 * Prices are whole dollars per day on a 365-day term so the math is easy to check.
 */
export type CoverageDefinition = {
  code: string;
  name: string;
  description: string;
  annualPremiumCents: number;
  required: boolean;
  /** The most that is paid for one claim under this coverage. */
  limitCents: number;
};

/** The part of every approved loss the customer bears themselves. */
export const CLAIM_DEDUCTIBLE_CENTS = 50_000;

/**
 * The largest loss that can be entered on a claim: $20,000,000.00. Amounts
 * are stored as whole cents in a 32-bit column, which holds a little over
 * $21 million. No payout is affected: the most any coverage pays is its
 * per-claim limit, and the highest limit is $1,000,000.00.
 */
export const MAX_CLAIM_CENTS = 2_000_000_000;

/**
 * When premium falls due. One rule, stated on the application the policyholder
 * signs and applied on the policy page: a policy whose term hasn't started
 * shows its premium as due on the first day of the term, and one whose term
 * has started shows it as due now.
 */
export const PREMIUM_DUE_RULE =
  "The premium is due in full on the first day of the policy term, or on the day the policy is issued if that is later.";

/** The broker's commission on premium, in basis points. 1000 = 10%. */
export const COMMISSION_RATE_BPS = 1000;

export const PRODUCT = {
  code: "SBP",
  name: "Small Business Package",
  termDescription: "12-month term",
} as const;

export const COVERAGES: readonly CoverageDefinition[] = [
  {
    code: "GL",
    name: "General Liability",
    description: "Injury or property damage claims from customers and the public.",
    annualPremiumCents: 109_500,
    required: true,
    limitCents: 100_000_000,
  },
  {
    code: "CYBER",
    name: "Cyber Liability",
    description: "Data breaches, ransomware, and related costs.",
    annualPremiumCents: 73_000,
    required: false,
    limitCents: 25_000_000,
  },
  {
    code: "PROP",
    name: "Business Property",
    description: "Equipment, inventory, and furnishings at the business location.",
    annualPremiumCents: 36_500,
    required: false,
    limitCents: 5_000_000,
  },
];

export const REQUIRED_COVERAGE_CODES = COVERAGES.filter((c) => c.required).map((c) => c.code);

export function getCoverage(code: string): CoverageDefinition {
  const coverage = COVERAGES.find((c) => c.code === code);
  if (!coverage) throw new Error(`Unknown coverage: ${code}`);
  return coverage;
}

export function coverageName(code: string): string {
  return COVERAGES.find((c) => c.code === code)?.name ?? code;
}
