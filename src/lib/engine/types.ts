import type { ISODate } from "./dates";

/** A coverage and the annual price that applied when it was put on the policy. */
export type CoverageRate = { code: string; annualPremiumCents: number };

/**
 * The things that can happen to a policy that change its premium. These are
 * stored as the `data` of a PolicyTransaction.
 */
export type IssueEvent = {
  type: "ISSUE";
  startDate: ISODate;
  endDate: ISODate;
  coverages: CoverageRate[];
};

export type CoverageChangeEvent = {
  type: "COVERAGE_CHANGE";
  effectiveDate: ISODate;
  add: CoverageRate[];
  remove: string[];
};

export type CancellationEvent = {
  type: "CANCELLATION";
  effectiveDate: ISODate;
};

export type PolicyEvent = IssueEvent | CoverageChangeEvent | CancellationEvent;

/** An event in the policy's history. `id` is the id of the action it came from. */
export type HistoryItem = { id: string; event: PolicyEvent };

/**
 * One line of premium. `amountCents` is signed: a charge is positive (the
 * customer owes more), a credit is negative (the customer owes less).
 * The other fields are the inputs to the formula, kept so anyone can redo it:
 *
 *     annualPremiumCents × days ÷ termDays = |amountCents|
 */
export type PremiumLine = {
  eventId: string;
  coverageCode: string;
  kind: "CHARGE" | "CREDIT";
  amountCents: number;
  annualPremiumCents: number;
  days: number;
  termDays: number;
  /** First day this line covers. */
  from: ISODate;
  /** The day after the last day this line covers. */
  to: ISODate;
};

/** A stretch of days a coverage is in force: from `from` up to, not including, `to`. */
export type CoverageInterval = {
  code: string;
  annualPremiumCents: number;
  from: ISODate;
  to: ISODate;
};

export type PolicyState = {
  startDate: ISODate;
  endDate: ISODate;
  termDays: number;
  /** Null unless the policy has been cancelled. */
  cancelledEffective: ISODate | null;
  /** When each coverage is in force, after every event has been applied. */
  intervals: CoverageInterval[];
  /** Premium lines grouped by the event that produced them. */
  linesByEvent: Map<string, PremiumLine[]>;
};

/** A rule was broken. The message is written to be shown to the broker. */
export class PolicyRuleError extends Error {
  constructor(
    message: string,
    /** The event that couldn't be applied. */
    public readonly eventId?: string,
  ) {
    super(message);
    this.name = "PolicyRuleError";
  }
}
