import { coverageName } from "./catalog";
import { formatDate } from "./dates";
import { formatUSD, proRate } from "./money";
import type { PremiumLine } from "./types";

/**
 * "$730.00 × 341 ÷ 365 days = $682.00"
 *
 * The result shown is always worked out from the three numbers in front of
 * it, so the arithmetic on screen is true whatever the line's amount is.
 *
 * One kind of line has an amount that differs from its formula: a credit on a
 * policy cancelled from its first day, moved by a cent to bring the coverage
 * to exactly zero, and any reversal of that credit. For those the formula's
 * own result is shown first, and then the adjustment to the line's amount.
 * Working from the amounts, and not from the line's record of how it was
 * rounded, gets this right for a reversal too, where every sign is flipped.
 */
export function formulaFor(line: Pick<PremiumLine, "annualPremiumCents" | "days" | "termDays" | "amountCents">): string {
  const result = proRate(line.annualPremiumCents, line.days, line.termDays);
  const amount = Math.abs(line.amountCents);
  const formula = `${formatUSD(line.annualPremiumCents)} × ${line.days} ÷ ${line.termDays} days = ${formatUSD(result)}`;
  if (amount === result) return formula;
  return `${formula}, adjusted by ${formatUSD(Math.abs(amount - result))} to ${formatUSD(amount)} so that this coverage comes to exactly $0.00, because the policy was cancelled from its first day`;
}

/** "Cyber Liability, Oct 25, 2026 to Oct 1, 2027 (341 days)" */
export function periodFor(line: Pick<PremiumLine, "coverageCode" | "from" | "to" | "days">): string {
  return `${coverageName(line.coverageCode)}, ${formatDate(line.from)} to ${formatDate(line.to)} (${line.days} ${line.days === 1 ? "day" : "days"})`;
}
