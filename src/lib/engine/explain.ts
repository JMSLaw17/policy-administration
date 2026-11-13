import { coverageName } from "./catalog";
import { formatDate } from "./dates";
import { formatUSD } from "./money";
import type { PremiumLine } from "./types";

/**
 * "$730.00 × 341 ÷ 365 days = $682.00"
 *
 * For a line that was moved to make a policy cancelled from its first day come
 * to exactly zero, the formula's own result is shown, and then the adjustment.
 */
export function formulaFor(
  line: Pick<PremiumLine, "annualPremiumCents" | "days" | "termDays" | "amountCents" | "roundingCents">,
): string {
  const rounding = line.roundingCents ?? 0;
  const formula = `${formatUSD(line.annualPremiumCents)} × ${line.days} ÷ ${line.termDays} days = ${formatUSD(Math.abs(line.amountCents - rounding))}`;
  if (rounding === 0) return formula;
  return `${formula}, adjusted by ${formatUSD(Math.abs(rounding))} to ${formatUSD(Math.abs(line.amountCents))} so that this coverage comes to exactly $0.00, because the policy was cancelled from its first day`;
}

/** "Cyber Liability, Oct 25, 2026 to Oct 1, 2027 (341 days)" */
export function periodFor(line: Pick<PremiumLine, "coverageCode" | "from" | "to" | "days">): string {
  return `${coverageName(line.coverageCode)}, ${formatDate(line.from)} to ${formatDate(line.to)} (${line.days} ${line.days === 1 ? "day" : "days"})`;
}
