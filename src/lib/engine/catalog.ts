/**
 * The one product we sell, with a flat annual premium per coverage.
 * Simplification: no rating factors (industry, revenue, limits), taxes, or fees.
 * Prices are whole dollars per day on a 365-day term so the math is easy to check.
 */
export type CoverageDefinition = {
  code: string;
  name: string;
  description: string;
  annualPremiumCents: number;
  required: boolean;
};

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
  },
  {
    code: "CYBER",
    name: "Cyber Liability",
    description: "Data breaches, ransomware, and related costs.",
    annualPremiumCents: 73_000,
    required: false,
  },
  {
    code: "PROP",
    name: "Business Property",
    description: "Equipment, inventory, and furnishings at the business location.",
    annualPremiumCents: 36_500,
    required: false,
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
