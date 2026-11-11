/**
 * Calendar dates with no time and no time zone, as "YYYY-MM-DD" strings.
 * Insurance coverage is counted in whole days, so we never use clock times.
 */
export type ISODate = string;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

function toUTC(date: ISODate): number {
  if (!isISODate(date)) throw new Error(`Not a valid date: ${date}`);
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== "string" || !ISO_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Days from `from` up to but not including `to`. Oct 1 to Oct 8 is 7 days.
 * A policy from Oct 1 to the next Oct 1 is 365 days (366 across a leap day).
 */
export function daysBetween(from: ISODate, to: ISODate): number {
  return Math.round((toUTC(to) - toUTC(from)) / MS_PER_DAY);
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromJSDate(new Date(toUTC(date) + days * MS_PER_DAY));
}

/** Same month and day one year later. Feb 29 becomes Mar 1. */
export function addOneYear(date: ISODate): ISODate {
  const [y, m, d] = date.split("-").map(Number);
  return fromJSDate(new Date(Date.UTC(y + 1, m - 1, d)));
}

/** ISO strings compare correctly as plain strings. */
export const isBefore = (a: ISODate, b: ISODate) => a < b;
export const maxDate = (a: ISODate, b: ISODate) => (a > b ? a : b);

/** For Prisma `@db.Date` values, which arrive as JS Dates at UTC midnight. */
export function fromJSDate(date: Date): ISODate {
  return date.toISOString().slice(0, 10);
}

export function toJSDate(date: ISODate): Date {
  return new Date(toUTC(date));
}

export function todayISO(now: Date = new Date()): ISODate {
  // The demo runs for US customers; use US Eastern as "today".
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

export function formatDate(date: ISODate): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(toJSDate(date));
}
