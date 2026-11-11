import "server-only";
import { db } from "@/lib/db";
import {
  coverageName,
  formatDate,
  fromJSDate,
  replay,
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
  paymentId: string | null;
  refundId: string | null;
};

export type HistoryEntry = {
  id: string;
  seq: number;
  type: "ISSUE" | "COVERAGE_CHANGE" | "CORRECTION" | "CANCELLATION" | "DETAILS_CHANGE";
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
  /** The event as it currently stands, if this entry can be corrected. */
  correctable: PolicyEvent | null;
};

export type PolicyView = Awaited<ReturnType<typeof loadPolicyView>>;

export async function loadPolicyView(policyId: string) {
  const policy = await db.policy.findUnique({
    where: { id: policyId },
    include: {
      customer: true,
      transactions: { orderBy: { seq: "asc" }, include: { createdBy: { select: { name: true } } } },
      ledger: { orderBy: { seq: "asc" } },
      payments: { orderBy: { createdAt: "asc" } },
      refunds: { orderBy: { createdAt: "asc" } },
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
      title = titleFor(event);
      summary = summarise(event);
    } else if (t.type === "DETAILS_CHANGE") {
      summary = describeDetails(t.data);
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
      netCents: rows.reduce((sum, r) => sum + r.amountCents, 0),
      statementLines: rows.map((r) => r.line),
      correctsSeq: corrected?.seq ?? null,
      supersededBySeq: superseding?.seq ?? null,
      correctable: slot ? slot.event : null,
    };
  });

  const balanceCents = running;

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
    coverage: state.intervals,
    statement,
    history,
    balanceCents,
    payments: policy.payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      status: p.status,
      stripePaymentIntentId: p.stripePaymentIntentId,
      failureReason: p.failureReason,
      createdAt: p.createdAt.toISOString(),
      statementLine: statement.find((r) => r.paymentId === p.id)?.line ?? null,
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
