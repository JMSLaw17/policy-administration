import "server-only";
import { db } from "@/lib/db";
import {
  coverageName,
  daysBetween,
  formatDate,
  formatUSD,
  fromJSDate,
  replay,
  todayISO,
  type ISODate,
  type PolicyEvent,
  type PolicyState,
} from "@/lib/engine";
import { buildSlots, PolicyEventSchema, toHistory } from "./history";
import type { LineCalc } from "./service";

/**
 * Everything the policy page shows, for both roles, in plain serialisable data.
 */

export type StatementRow = {
  id: string;
  /** Line number on this policy's statement, starting at 1. */
  line: number;
  postedAt: string;
  kind: "CHARGE" | "CREDIT" | "REVERSAL" | "PAYMENT" | "REFUND";
  description: string;
  amountCents: number;
  balanceAfterCents: number;
  coverageCode: string | null;
  calc: LineCalc | null;
  /** The history entry that wrote this line. */
  postedBySeq: number | null;
  /** If this line was later reversed: the reversing line and the correction behind it. */
  reversedByLine: number | null;
  reversedBySeq: number | null;
  /** If this line is a reversal: the line it cancels out. */
  reversesLine: number | null;
  /** If this line is money the bank took back from a payment: that payment's line. */
  returnsLine: number | null;
  /** On a payment line: how much of it the bank has since taken back. */
  returnedCents: number;
  paymentId: string | null;
  refundId: string | null;
};

export type HistoryEntry = {
  id: string;
  seq: number;
  type: "ISSUE" | "COVERAGE_CHANGE" | "CORRECTION" | "CANCELLATION" | "DETAILS_CHANGE" | "NOTE";
  title: string;
  summary: string;
  effectiveDate: ISODate;
  createdAt: string;
  createdBy: string;
  reason: string | null;
  /** Net effect of this action on the amount due. */
  netCents: number;
  statementLines: number[];
  correctsSeq: number | null;
  supersededBySeq: number | null;
  /** For corrections: what changed and why the amount moved, in plain English. */
  explanation: string | null;
  /** The event as it currently stands, if this entry can be corrected. */
  correctable: PolicyEvent | null;
};

/**
 * One row of the explanation of what is owed now: a change to the policy, or a
 * payment or refund. The rows always add up to the amount due.
 */
export type DueReason = {
  /** The history entry behind a change, so the note can link to it. Null for a payment or refund. */
  seq: number | null;
  /** The statement line of a payment or refund. Null for a change. */
  line: number | null;
  title: string;
  /** What was changed and, for a correction, why the amount moved. */
  text: string;
  /** The reason the broker gave, if any. */
  reason: string | null;
  recordedAt: string;
  netCents: number;
};

/** The statement added up: premium − payments + refunds = balance. */
export type StatementTotals = {
  /** Charges less reversals and credits. */
  premiumCents: number;
  paidCents: number;
  refundedCents: number;
};

/** Days with no cover between this policy and the one before or after it. */
export type CoverageGap = {
  /** Where the other policy sits: the one this renews (BEFORE) or its renewal (AFTER). */
  side: "BEFORE" | "AFTER";
  policyId: string;
  policyNumber: string;
  from: ISODate;
  to: ISODate;
  days: number;
};

const linkedPolicy = { id: true, policyNumber: true, startDate: true, endDate: true, cancelledEffective: true } as const;

export type PolicyView = Awaited<ReturnType<typeof loadPolicyView>>;

export async function loadPolicyView(policyId: string) {
  const policy = await db.policy.findUnique({
    where: { id: policyId },
    include: {
      customer: true,
      transactions: { orderBy: { seq: "asc" }, include: { createdBy: { select: { name: true } } } },
      ledger: { orderBy: { seq: "asc" }, include: { paymentReturn: true } },
      payments: { orderBy: { createdAt: "asc" } },
      refunds: { orderBy: { createdAt: "asc" } },
      application: true,
      renewedFrom: { select: linkedPolicy },
      renewal: { select: linkedPolicy },
    },
  });
  if (!policy) return null;

  const slots = buildSlots(policy.transactions);
  const state: PolicyState = replay(toHistory(slots));
  const txById = new Map(policy.transactions.map((t) => [t.id, t]));
  const seqOf = (id: string | null) => (id ? (txById.get(id)?.seq ?? null) : null);

  // Statement rows with a running balance.
  const lineOf = new Map(policy.ledger.map((e, i) => [e.id, i + 1]));
  const reversalOf = new Map(
    policy.ledger.filter((e) => e.reversesEntryId).map((e) => [e.reversesEntryId!, e]),
  );
  // Money the bank took back, by the payment it was taken from.
  const paymentLine = new Map(policy.ledger.filter((e) => e.paymentId).map((e) => [e.paymentId!, lineOf.get(e.id)!]));
  const returnedFrom = new Map<string, number>();
  for (const e of policy.ledger) {
    if (!e.paymentReturn) continue;
    returnedFrom.set(e.paymentReturn.paymentId, (returnedFrom.get(e.paymentReturn.paymentId) ?? 0) + e.amountCents);
  }
  let running = 0;
  const statement: StatementRow[] = policy.ledger.map((e, i) => {
    running += e.amountCents;
    const reversal = reversalOf.get(e.id);
    return {
      id: e.id,
      line: i + 1,
      postedAt: e.postedAt.toISOString(),
      kind: e.kind,
      description: e.description,
      amountCents: e.amountCents,
      balanceAfterCents: running,
      coverageCode: e.coverageCode,
      calc: (e.calc as LineCalc | null) ?? null,
      postedBySeq: seqOf(e.postedByTransactionId),
      reversedByLine: reversal ? lineOf.get(reversal.id)! : null,
      reversedBySeq: reversal ? seqOf(reversal.postedByTransactionId) : null,
      reversesLine: e.reversesEntryId ? lineOf.get(e.reversesEntryId)! : null,
      returnsLine: e.paymentReturn ? (paymentLine.get(e.paymentReturn.paymentId) ?? null) : null,
      returnedCents: e.paymentId ? (returnedFrom.get(e.paymentId) ?? 0) : 0,
      paymentId: e.paymentId,
      refundId: e.refundId,
    };
  });

  // History entries.
  const supersededBy = new Map(
    policy.transactions.filter((t) => t.correctsId).map((t) => [t.correctsId!, t]),
  );
  const history: HistoryEntry[] = policy.transactions.map((t) => {
    const rows = statement.filter((r) => r.postedBySeq === t.seq);
    const parsed = PolicyEventSchema.safeParse(t.data);
    const event = parsed.success ? parsed.data : null;
    const corrected = t.correctsId ? txById.get(t.correctsId) : null;
    const previous = corrected ? PolicyEventSchema.safeParse(corrected.data) : null;
    const superseding = supersededBy.get(t.id);
    const slot = slots.find((s) => s.latest.id === t.id);

    let title = "Details updated";
    let summary = "";
    if (t.type === "CORRECTION" && event && corrected && previous?.success) {
      title = `Correction to #${corrected.seq}`;
      summary = describeCorrection(previous.data, event);
    } else if (event) {
      title = event.type === "ISSUE" && policy.renewedFrom ? "Policy renewed" : titleFor(event);
      summary = summarise(event);
    } else if (t.type === "DETAILS_CHANGE") {
      summary = describeDetails(t.data);
    } else if (t.type === "NOTE") {
      const note = t.data as { title?: string; note?: string } | null;
      title = note?.title ?? "Note";
      summary = note?.note ?? "";
    }

    return {
      id: t.id,
      seq: t.seq,
      type: t.type,
      title,
      summary,
      effectiveDate: fromJSDate(t.effectiveDate),
      createdAt: t.createdAt.toISOString(),
      createdBy: t.createdBy.name,
      reason: t.reason,
      // Premium only. A refund this action triggered is money moving, not a change in what's owed.
      netCents: rows.filter((r) => r.kind !== "REFUND").reduce((sum, r) => sum + r.amountCents, 0),
      statementLines: rows.map((r) => r.line),
      explanation: t.type === "CORRECTION" ? explainCorrection(rows) : null,
      correctsSeq: corrected?.seq ?? null,
      supersededBySeq: superseding?.seq ?? null,
      correctable: slot ? slot.event : null,
    };
  });

  const balanceCents = running;
  const sumOf = (...kinds: StatementRow["kind"][]) =>
    statement.filter((r) => kinds.includes(r.kind)).reduce((sum, r) => sum + r.amountCents, 0);
  const totals: StatementTotals = {
    premiumCents: sumOf("CHARGE", "CREDIT", "REVERSAL"),
    paidCents: 0 - sumOf("PAYMENT"), // "0 -" so that nothing paid is 0, not -0
    refundedCents: sumOf("REFUND"),
  };

  // Gaps between this policy and the one it renews, or its renewal. A policy
  // cancelled from its first day covers nothing, so there's nothing to be apart from.
  const coverEnd = state.cancelledEffective ?? state.endDate;
  const gaps: CoverageGap[] = [];
  const earlier = policy.renewedFrom;
  if (earlier && state.startDate < coverEnd) {
    const earlierEnd = fromJSDate(earlier.cancelledEffective ?? earlier.endDate);
    if (earlierEnd < state.startDate) {
      gaps.push({
        side: "BEFORE",
        policyId: earlier.id,
        policyNumber: earlier.policyNumber,
        from: earlierEnd,
        to: state.startDate,
        days: daysBetween(earlierEnd, state.startDate),
      });
    }
  }
  const later = policy.renewal;
  if (later) {
    const laterStart = fromJSDate(later.startDate);
    const laterEnd = fromJSDate(later.cancelledEffective ?? later.endDate);
    if (laterStart < laterEnd && coverEnd < laterStart) {
      gaps.push({
        side: "AFTER",
        policyId: later.id,
        policyNumber: later.policyNumber,
        from: coverEnd,
        to: laterStart,
        days: daysBetween(coverEnd, laterStart),
      });
    }
  }

  return {
    id: policy.id,
    policyNumber: policy.policyNumber,
    status: policy.status,
    startDate: state.startDate,
    endDate: state.endDate,
    termDays: state.termDays,
    cancelledEffective: state.cancelledEffective,
    customer: {
      id: policy.customer.id,
      businessName: policy.customer.businessName,
      contactName: policy.customer.contactName,
      email: policy.customer.email,
      address: `${policy.customer.addressLine1}, ${policy.customer.city}, ${policy.customer.state} ${policy.customer.postalCode}`,
    },
    application: policy.application?.signedAt
      ? {
          id: policy.application.id,
          signerName: policy.application.signerName,
          signedAt: policy.application.signedAt.toISOString(),
          envelopeId: policy.application.docusignEnvelopeId,
        }
      : null,
    // Premium falls due when the term starts. Until then it can be paid early
    // but isn't overdue. This matters for renewals, which are created ahead of time.
    dueDate: state.startDate > todayISO() ? state.startDate : null,
    demoLoadedAt: policy.demoLoadedAt?.toISOString() ?? null,
    renewedFrom: policy.renewedFrom && { id: policy.renewedFrom.id, policyNumber: policy.renewedFrom.policyNumber },
    renewal: policy.renewal && { id: policy.renewal.id, policyNumber: policy.renewal.policyNumber },
    gaps,
    coverage: state.intervals,
    statement,
    history,
    balanceCents,
    totals,
    dueBecause: reasonsForBalance(history, statement, balanceCents),
    payments: policy.payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      status: p.status,
      stripePaymentIntentId: p.stripePaymentIntentId,
      failureReason: p.failureReason,
      createdAt: p.createdAt.toISOString(),
      statementLine: statement.find((r) => r.paymentId === p.id)?.line ?? null,
      /** How much of this payment the bank has since taken back. */
      returnedCents: returnedFrom.get(p.id) ?? 0,
    })),
    refunds: policy.refunds.map((r) => ({
      id: r.id,
      amountCents: r.amountCents,
      status: r.status,
      stripeRefundId: r.stripeRefundId,
      failureReason: r.failureReason,
      paymentId: r.paymentId,
      createdAt: r.createdAt.toISOString(),
      statementLine: statement.find((s) => s.refundId === r.id)?.line ?? null,
    })),
  };
}

/**
 * Explains the amount due as rows that add up to it exactly.
 *
 * Payments settle the oldest premium first, so what is still owed belongs to
 * the newest changes. Walking back from the newest change, the first point at
 * which the changes add up to the amount due gives the explanation. Usually
 * that is one entry: the change made since the customer last paid.
 *
 * If no run of recent changes comes to exactly the amount due (a payment
 * covered part of a change), the explanation is instead everything on the
 * statement since the balance was last zero, payments and refunds included.
 * That always adds up, because it is how the balance got from zero to here.
 */
function reasonsForBalance(history: HistoryEntry[], statement: StatementRow[], balanceCents: number): DueReason[] {
  if (balanceCents <= 0) return [];
  const forChange = (entry: HistoryEntry, netCents: number): DueReason => ({
    seq: entry.seq,
    line: null,
    title: entry.title,
    text: [entry.summary, entry.explanation].filter(Boolean).join(" "),
    reason: entry.reason,
    recordedAt: entry.createdAt,
    netCents,
  });

  // Everything on the statement since the balance was last zero.
  let from = 0;
  statement.forEach((row, i) => {
    if (row.balanceAfterCents === 0) from = i + 1;
  });
  const since = statement.slice(from);
  // If a payment was taken back by the bank in that time, that is the reason, and it is shown as such.
  const paymentReturned = since.some((row) => row.returnsLine !== null);

  const changes = history.filter((entry) => entry.netCents !== 0);
  let sum = 0;
  for (let i = changes.length - 1; i >= 0 && !paymentReturned; i--) {
    sum += changes[i].netCents;
    if (sum === balanceCents) return changes.slice(i).map((entry) => forChange(entry, entry.netCents));
  }

  const reasons: DueReason[] = [];
  for (const row of since) {
    const entry = history.find((h) => h.seq === row.postedBySeq);
    if (row.kind === "PAYMENT" || row.kind === "REFUND" || !entry) {
      reasons.push({
        seq: null,
        line: row.line,
        title: row.description,
        text: "",
        reason: null,
        recordedAt: row.postedAt,
        netCents: row.amountCents,
      });
      continue;
    }
    // One row per change, however many statement lines it posted.
    const existing = reasons.find((r) => r.seq === entry.seq);
    if (existing) existing.netCents += row.amountCents;
    else reasons.push(forChange(entry, row.amountCents));
  }
  return reasons.filter((r) => r.netCents !== 0);
}

const list = (codes: string[]) => codes.map(coverageName).join(", ");

function titleFor(event: PolicyEvent) {
  if (event.type === "ISSUE") return "Policy issued";
  if (event.type === "CANCELLATION") return "Policy cancelled";
  return "Coverage changed";
}

function summarise(event: PolicyEvent): string {
  if (event.type === "ISSUE") {
    return `${list(event.coverages.map((c) => c.code))} for ${formatDate(event.startDate)} to ${formatDate(event.endDate)}.`;
  }
  if (event.type === "CANCELLATION") {
    return `Coverage ends ${formatDate(event.effectiveDate)}. Unused days are credited pro-rata.`;
  }
  const parts: string[] = [];
  if (event.add.length) parts.push(`added ${list(event.add.map((c) => c.code))}`);
  if (event.remove.length) parts.push(`removed ${list(event.remove)}`);
  const text = parts.join(" and ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}, effective ${formatDate(event.effectiveDate)}.`;
}

/** Plain-English account of what a correction changed. */
function describeCorrection(before: PolicyEvent, after: PolicyEvent): string {
  const changes: string[] = [];
  const dateOf = (e: PolicyEvent) => (e.type === "ISSUE" ? e.startDate : e.effectiveDate);
  if (dateOf(before) !== dateOf(after)) {
    const what = before.type === "ISSUE" ? "Policy start date" : "Effective date";
    changes.push(`${what} corrected from ${formatDate(dateOf(before))} to ${formatDate(dateOf(after))}.`);
  }
  const codes = (e: PolicyEvent) =>
    e.type === "ISSUE"
      ? { add: e.coverages.map((c) => c.code), remove: [] as string[] }
      : e.type === "COVERAGE_CHANGE"
        ? { add: e.add.map((c) => c.code), remove: e.remove }
        : { add: [], remove: [] };
  const b = codes(before);
  const a = codes(after);
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((c) => y.includes(c));
  if (!same(a.add, b.add)) {
    changes.push(`Coverages ${before.type === "ISSUE" ? "issued" : "added"} corrected from ${list(b.add) || "none"} to ${list(a.add) || "none"}.`);
  }
  if (!same(a.remove, b.remove)) {
    changes.push(`Coverages removed corrected from ${list(b.remove) || "none"} to ${list(a.remove) || "none"}.`);
  }
  return changes.join(" ") || "No change.";
}

function describeDetails(data: unknown): string {
  const changes = (data as { changes?: { field: string; from: string; to: string }[] })?.changes ?? [];
  return changes.map((c) => `${c.field} changed from "${c.from}" to "${c.to}".`).join(" ");
}

/**
 * Explains a correction's money effect from its statement lines, coverage by
 * coverage: how many days changed, what the premium was and is now, and the
 * net result for the customer.
 */
function explainCorrection(rows: StatementRow[]): string | null {
  const premium = rows.filter((r) => r.kind !== "REFUND" && r.calc && r.coverageCode);
  if (premium.length === 0) return null;

  const sentences: string[] = [];
  const codes = [...new Set(premium.map((r) => r.coverageCode!))];
  for (const code of codes) {
    const name = coverageName(code);
    // A reversal carries the original line's inputs, with the opposite sign.
    const before = premium.filter((r) => r.coverageCode === code && r.kind === "REVERSAL");
    const after = premium.filter((r) => r.coverageCode === code && r.kind !== "REVERSAL");
    const oldAmount = -before.reduce((s, r) => s + r.amountCents, 0);
    const newAmount = after.reduce((s, r) => s + r.amountCents, 0);
    // Days paid for: a charge adds its days and a credit (unused days handed
    // back, after a cancellation or removal) takes its days away. A reversal
    // carries the opposite sign to the line it cancels, so flip it back.
    const daysOf = (r: StatementRow) => Math.sign(r.kind === "REVERSAL" ? -r.amountCents : r.amountCents) * r.calc!.days;
    const oldDays = before.reduce((s, r) => s + daysOf(r), 0);
    const newDays = after.reduce((s, r) => s + daysOf(r), 0);
    const word = (cents: number) => (cents < 0 ? "credit" : "charge");
    const plural = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
    const amounts = `changes from ${formatUSD(Math.abs(oldAmount))} to ${formatUSD(Math.abs(newAmount))}`;

    if (before.length && after.length) {
      const { annualPremiumCents, termDays } = after[0].calc!;
      const daily =
        annualPremiumCents % termDays === 0 ? ` at ${formatUSD(annualPremiumCents / termDays)} a day` : "";
      // "7 more days (341 instead of 334) at $2.00 a day", for counts that are both on the same side.
      const count = (now: number, was: number) =>
        now === was
          ? `the same ${plural(now)}`
          : `${Math.abs(now - was)} ${now > was ? "more" : "fewer"} ${Math.abs(now - was) === 1 ? "day" : "days"} (${now} instead of ${was})${daily}`;
      if (oldDays >= 0 && newDays >= 0) {
        sentences.push(`${name} now counts ${count(newDays, oldDays)}, so its ${word(newAmount)} ${amounts}.`);
      } else if (oldDays <= 0 && newDays <= 0) {
        // Only days handed back are involved, so talk about the credit.
        sentences.push(`${name} is now credited for ${count(-newDays, -oldDays)}, so its credit ${amounts}.`);
      } else {
        sentences.push(
          `${name}: the ${word(oldAmount)} of ${formatUSD(Math.abs(oldAmount))} becomes a ${word(newAmount)} of ${formatUSD(Math.abs(newAmount))}.`,
        );
      }
    } else if (after.length) {
      sentences.push(
        `${name} now has a ${word(newAmount)} of ${formatUSD(Math.abs(newAmount))} for ${plural(Math.abs(newDays))}.`,
      );
    } else {
      sentences.push(`The ${formatUSD(Math.abs(oldAmount))} ${word(oldAmount)} for ${name} no longer applies.`);
    }
  }

  const net = premium.reduce((s, r) => s + r.amountCents, 0);
  const refunded = rows.filter((r) => r.kind === "REFUND").reduce((s, r) => s + r.amountCents, 0);
  if (net > 0) sentences.push(`In total, ${formatUSD(net)} more is owed.`);
  else if (net < 0) {
    sentences.push(
      refunded > 0
        ? `In total, ${formatUSD(-net)} less is owed, and ${formatUSD(refunded)} was refunded to the original payment method.`
        : `In total, ${formatUSD(-net)} less is owed.`,
    );
  } else sentences.push("The total owed doesn't change.");
  return sentences.join(" ");
}
