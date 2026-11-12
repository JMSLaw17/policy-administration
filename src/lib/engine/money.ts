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

/**
 * The smallest amount that can be collected by card or bank debit: Stripe
 * won't charge less than $0.50 in USD. A smaller amount due (a few cents left
 * by rounding across a leap year, say) stays on the statement and is
 * collected with the next amount that takes the total to $0.50 or more.
 */
export const MIN_PAYMENT_CENTS = 50;

/** True for an amount that is owed but too small to collect on its own. */
export const isBelowMinimumPayment = (cents: number) => cents > 0 && cents < MIN_PAYMENT_CENTS;

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

/** Reads a typed dollar amount such as "4,000" or "$4000.50" into cents. Null if it isn't one. */
export function parseUSD(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [dollars, cents = ""] = cleaned.split(".");
  return Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
}
