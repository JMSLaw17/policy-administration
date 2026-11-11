import { coverageName } from "./catalog";
import { formatDate } from "./dates";
import { formatUSD } from "./money";
import type { PremiumLine } from "./types";

/** "$730.00 × 341 ÷ 365 days = $682.00" */
export function formulaFor(line: Pick<PremiumLine, "annualPremiumCents" | "days" | "termDays" | "amountCents">): string {
  return `${formatUSD(line.annualPremiumCents)} × ${line.days} ÷ ${line.termDays} days = ${formatUSD(Math.abs(line.amountCents))}`;
}

/** "Cyber Liability, Oct 25, 2026 to Oct 1, 2027 (341 days)" */
export function periodFor(line: Pick<PremiumLine, "coverageCode" | "from" | "to" | "days">): string {
  return `${coverageName(line.coverageCode)}, ${formatDate(line.from)} to ${formatDate(line.to)} (${line.days} ${line.days === 1 ? "day" : "days"})`;
}
