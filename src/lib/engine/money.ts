/**
 * All money is whole cents (integers) in USD. No floating point dollars.
 */

/**
 * The premium for `days` out of a `termDays`-day term:
 *
 *     annual premium × days ÷ days in term
 *
 * rounded to the nearest cent, with exact halves rounding up. Done in integer
 * arithmetic so the result is identical everywhere it's computed.
 */
export function proRate(annualPremiumCents: number, days: number, termDays: number): number {
  if (!Number.isInteger(annualPremiumCents) || annualPremiumCents < 0) {
    throw new Error("Premium must be a whole, non-negative number of cents");
  }
  if (!Number.isInteger(days) || days < 0) throw new Error("Days must be a whole number, 0 or more");
  if (!Number.isInteger(termDays) || termDays <= 0) throw new Error("Term must be at least 1 day");
  return Math.floor((2 * annualPremiumCents * days + termDays) / (2 * termDays));
}

/** 123456 -> "$1,234.56", -1400 -> "-$14.00" */
export function formatUSD(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rest}`;
}

/** For changes in what's owed: "+$14.00", "-$14.00", "$0.00". */
export function signedUSD(cents: number): string {
  return cents > 0 ? `+${formatUSD(cents)}` : formatUSD(cents);
}
