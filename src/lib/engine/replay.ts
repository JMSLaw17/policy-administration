import { coverageName, REQUIRED_COVERAGE_CODES } from "./catalog";
import { daysBetween, formatDate, maxDate, type ISODate } from "./dates";
import { proRate } from "./money";
import {
  PolicyRuleError,
  type CoverageInterval,
  type HistoryItem,
  type PolicyState,
  type PremiumLine,
} from "./types";

/**
 * Works out a policy's coverage and premium by applying its history in order.
 *
 * This is the single place premium is calculated. Issuing, editing coverage,
 * correcting, and cancelling all call it, so the rules can't drift apart:
 *
 *  - Adding a coverage from date D charges   rate × days(D → term end) ÷ term days.
 *  - Removing a coverage from date D credits rate × days(D → its end)  ÷ term days.
 *  - Cancelling on date D credits every coverage for its days after D.
 *
 * Each line is rounded to the cent on its own. Nothing is ever re-rounded,
 * with one exception: a policy cancelled from its first day covered nothing,
 * so its lines are made to come to exactly zero (see the cancellation below).
 *
 * `history` is the effective history in the order the actions were taken. If
 * an action was later corrected, the corrected version sits in its place.
 * Throws PolicyRuleError if the history breaks a rule (for example, removing a
 * coverage on a date when it isn't in force).
 */
export function replay(history: HistoryItem[]): PolicyState {
  const [first, ...rest] = history;
  if (!first || first.event.type !== "ISSUE") {
    throw new PolicyRuleError("A policy's history must start with it being issued.");
  }

  const { startDate, endDate, coverages } = first.event;
  const termDays = daysBetween(startDate, endDate);
  if (termDays <= 0) {
    throw new PolicyRuleError("The policy must end after it starts.", first.id);
  }
  for (const code of REQUIRED_COVERAGE_CODES) {
    if (!coverages.some((c) => c.code === code)) {
      throw new PolicyRuleError(`${coverageName(code)} is required on every policy.`, first.id);
    }
  }
  if (new Set(coverages.map((c) => c.code)).size !== coverages.length) {
    throw new PolicyRuleError("Each coverage can only be listed once.", first.id);
  }

  const state: PolicyState = {
    startDate,
    endDate,
    termDays,
    cancelledEffective: null,
    intervals: [],
    linesByEvent: new Map(),
  };

  const line = (
    eventId: string,
    kind: PremiumLine["kind"],
    code: string,
    annualPremiumCents: number,
    from: ISODate,
    to: ISODate,
  ): PremiumLine => {
    const days = daysBetween(from, to);
    const amount = proRate(annualPremiumCents, days, termDays);
    return {
      eventId,
      coverageCode: code,
      kind,
      amountCents: kind === "CHARGE" ? amount : -amount,
      annualPremiumCents,
      days,
      termDays,
      from,
      to,
    };
  };

  // Issue: every chosen coverage for the full term.
  state.linesByEvent.set(
    first.id,
    coverages.map((c) => {
      state.intervals.push({ ...c, from: startDate, to: endDate });
      return line(first.id, "CHARGE", c.code, c.annualPremiumCents, startDate, endDate);
    }),
  );

  for (const { id, event } of rest) {
    if (event.type === "ISSUE") {
      throw new PolicyRuleError("A policy can only be issued once.", id);
    }
    if (state.cancelledEffective) {
      throw new PolicyRuleError(
        `The policy was cancelled effective ${formatDate(state.cancelledEffective)}, so it can't be changed after that.`,
        id,
      );
    }

    const date = event.effectiveDate;
    const lines: PremiumLine[] = [];

    if (event.type === "COVERAGE_CHANGE") {
      if (date < startDate || date >= endDate) {
        throw new PolicyRuleError(
          `Coverage changes must take effect during the policy term (${formatDate(startDate)} to ${formatDate(endDate)}).`,
          id,
        );
      }
      if (event.add.length === 0 && event.remove.length === 0) {
        throw new PolicyRuleError("Choose at least one coverage to add or remove.", id);
      }

      for (const code of event.remove) {
        if (REQUIRED_COVERAGE_CODES.includes(code)) {
          throw new PolicyRuleError(
            `${coverageName(code)} is required and can't be removed. Cancel the policy instead.`,
            id,
          );
        }
        const interval = state.intervals.find(
          (i) => i.code === code && i.from <= date && date < i.to,
        );
        if (!interval) {
          throw new PolicyRuleError(
            `${coverageName(code)} can't be removed on ${formatDate(date)} because it isn't in force on that date.`,
            id,
          );
        }
        // Credit the days from the removal date to where the coverage used to end.
        lines.push(line(id, "CREDIT", code, interval.annualPremiumCents, date, interval.to));
        interval.to = date;
      }
      state.intervals = state.intervals.filter((i) => i.from < i.to);

      for (const { code, annualPremiumCents } of event.add) {
        const overlap = state.intervals.find((i) => i.code === code && i.to > date);
        if (overlap) {
          throw new PolicyRuleError(
            `${coverageName(code)} can't be added from ${formatDate(date)} because it's already in force from ${formatDate(overlap.from)}.`,
            id,
          );
        }
        state.intervals.push({ code, annualPremiumCents, from: date, to: endDate });
        lines.push(line(id, "CHARGE", code, annualPremiumCents, date, endDate));
      }
    } else {
      // Cancellation: pro-rata, no penalty. Credit every day after the cancellation date.
      if (date < startDate || date > endDate) {
        throw new PolicyRuleError(
          `The cancellation date must be within the policy term (${formatDate(startDate)} to ${formatDate(endDate)}).`,
          id,
        );
      }
      for (const interval of state.intervals) {
        if (interval.to <= date) continue;
        const creditFrom = maxDate(interval.from, date);
        lines.push(
          line(id, "CREDIT", interval.code, interval.annualPremiumCents, creditFrom, interval.to),
        );
        interval.to = creditFrom;
      }
      state.intervals = state.intervals.filter((i) => i.from < i.to);
      state.cancelledEffective = date;

      // Cancelled from the first day: no day was ever covered, so nothing may
      // be left owing, or left as a credit. Lines rounded on their own can miss
      // by a cent (a coverage added and removed mid-term is a charge and two
      // credits, each rounded separately). So for each coverage, the last
      // credit is moved by whatever is needed to bring its lines to zero, and
      // the line records that it was.
      if (date === startDate) {
        const earlier = [...state.linesByEvent.values()].flat();
        for (const code of new Set(earlier.map((l) => l.coverageCode))) {
          const net = [...earlier, ...lines]
            .filter((l) => l.coverageCode === code)
            .reduce((sum, l) => sum + l.amountCents, 0);
          if (net === 0) continue;
          let last = lines.findLast((l) => l.coverageCode === code);
          if (!last) {
            // Nothing of this coverage was left to credit, so there is no line to adjust. Add one.
            const { annualPremiumCents } = earlier.findLast((l) => l.coverageCode === code)!;
            last = line(id, "CREDIT", code, annualPremiumCents, date, date);
            lines.push(last);
          }
          last.amountCents -= net;
          last.roundingCents = -net;
          if (last.amountCents > 0) last.kind = "CHARGE";
        }
      }
    }

    state.linesByEvent.set(id, lines);
  }

  state.intervals.sort((a, b) => a.from.localeCompare(b.from) || a.code.localeCompare(b.code));
  return state;
}

/** Coverages in force on a given day. */
export function coveragesInForceOn(state: PolicyState, date: ISODate): CoverageInterval[] {
  return state.intervals.filter((i) => i.from <= date && date < i.to);
}

/** Every premium line, in history order. */
export function allLines(state: PolicyState): PremiumLine[] {
  return [...state.linesByEvent.values()].flat();
}

/** Total premium for the policy as it stands: the sum of every line. */
export function totalPremiumCents(state: PolicyState): number {
  return allLines(state).reduce((sum, l) => sum + l.amountCents, 0);
}
