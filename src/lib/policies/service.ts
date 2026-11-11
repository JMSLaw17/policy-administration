import "server-only";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  addOneYear,
  allLines,
  coverageName,
  formatDate,
  getCoverage,
  planCorrection,
  PolicyRuleError,
  replay,
  toJSDate,
  type HistoryItem,
  type ISODate,
  type PolicyEvent,
  type PolicyState,
  type PostedLine,
  type PremiumLine,
} from "@/lib/engine";
import { buildSlots, rootIdByTransaction, toHistory, type Slot } from "./history";

/**
 * Every action that changes a policy's premium goes through `applyChange`:
 *
 *   1. Build the policy's history as it would be after the action.
 *   2. Replay it through the engine to get every premium line that should exist.
 *   3. Compare with the lines on the statement now.
 *   4. Post the difference: new lines, plus reversals for lines that are no
 *      longer right. Nothing already on the statement is touched.
 *
 * For a new action the difference is just that action's lines. For a
 * correction it is a reversal of the old lines plus the corrected ones.
 */

type Tx = Prisma.TransactionClient;

/** Placeholder id for the action being added, until it has a real one. */
const NEW = "__new__";

export type PlannedLine = {
  coverageCode: string;
  description: string;
  amountCents: number;
  calc: LineCalc;
};
export type LineCalc = {
  annualPremiumCents: number;
  days: number;
  termDays: number;
  from: ISODate;
  to: ISODate;
};

export type ChangePreview = {
  /** Lines on the statement that will be reversed, with the reversing amount. */
  reversals: PlannedLine[];
  /** New lines that will be posted. */
  postings: PlannedLine[];
  netChangeCents: number;
  balanceBeforeCents: number;
  balanceAfterCents: number;
};

export type ChangeRequest =
  | { kind: "COVERAGE_CHANGE"; effectiveDate: ISODate; add: string[]; remove: string[]; reason?: string }
  | { kind: "CANCELLATION"; effectiveDate: ISODate; reason?: string }
  | { kind: "CORRECTION"; transactionId: string; event: CorrectedEvent; reason?: string };

/** What the broker can change when correcting an action. */
export type CorrectedEvent =
  | { type: "ISSUE"; startDate: ISODate; coverages: string[] }
  | { type: "COVERAGE_CHANGE"; effectiveDate: ISODate; add: string[]; remove: string[] }
  | { type: "CANCELLATION"; effectiveDate: ISODate };

const rateFor = (code: string) => ({ code, annualPremiumCents: getCoverage(code).annualPremiumCents });

/* ------------------------------------------------------------------ */
/* Issue                                                               */
/* ------------------------------------------------------------------ */

export async function issuePolicy(input: {
  customerId: string;
  startDate: ISODate;
  coverageCodes: string[];
  userId: string;
}) {
  const event: PolicyEvent = {
    type: "ISSUE",
    startDate: input.startDate,
    endDate: addOneYear(input.startDate),
    coverages: input.coverageCodes.map(rateFor),
  };
  // Validates the event and gives us the charge lines.
  const state = replay([{ id: NEW, event }]);

  return db.$transaction(async (tx) => {
    const policy = await tx.policy.create({
      data: {
        policyNumber: await nextPolicyNumber(tx, input.startDate),
        customerId: input.customerId,
        productCode: "SBP",
        startDate: toJSDate(event.startDate),
        endDate: toJSDate(event.endDate),
      },
    });
    const transaction = await tx.policyTransaction.create({
      data: {
        policyId: policy.id,
        seq: 1,
        type: "ISSUE",
        effectiveDate: toJSDate(event.startDate),
        data: event,
        createdById: input.userId,
      },
    });
    for (const line of allLines(state)) {
      await tx.ledgerEntry.create({
        data: entryData(policy.id, transaction.id, transaction.id, line, describe(line, event)),
      });
    }
    return policy;
  });
}

async function nextPolicyNumber(tx: Tx, startDate: ISODate) {
  const count = await tx.policy.count();
  return `SBP-${startDate.slice(0, 4)}-${String(count + 1).padStart(4, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Edit coverage, cancel, correct                                      */
/* ------------------------------------------------------------------ */

/** Shows what an action would do to the statement, without saving anything. */
export async function previewChange(policyId: string, request: ChangeRequest): Promise<ChangePreview> {
  return db.$transaction(async (tx) => (await plan(tx, policyId, request)).preview);
}

/** Saves the action and posts its lines to the statement. */
export async function applyChange(policyId: string, request: ChangeRequest, userId: string) {
  return db.$transaction(async (tx) => {
    // One change at a time per policy, so two brokers can't post from the same starting point.
    await tx.$queryRaw`SELECT id FROM "Policy" WHERE id = ${policyId} FOR UPDATE`;
    const planned = await plan(tx, policyId, request);
    const { slots, state, newEvent, correctedSlot, toReverse, toPost, preview } = planned;

    const last = await tx.policyTransaction.aggregate({ where: { policyId }, _max: { seq: true } });
    const transaction = await tx.policyTransaction.create({
      data: {
        policyId,
        seq: (last._max.seq ?? 0) + 1,
        type: correctedSlot ? "CORRECTION" : newEvent.type,
        effectiveDate: toJSDate(newEvent.type === "ISSUE" ? newEvent.startDate : newEvent.effectiveDate),
        data: newEvent,
        reason: request.reason?.trim() || null,
        correctsId: correctedSlot?.latest.id ?? null,
        createdById: userId,
      },
    });

    // The action whose premium a line represents: this one, if the line belongs
    // to the slot being added or corrected, otherwise that slot's current version.
    const originFor = (eventId: string) => {
      if (eventId === NEW || eventId === correctedSlot?.root.id) return transaction.id;
      return slots.find((s) => s.root.id === eventId)!.latest.id;
    };
    const eventFor = (eventId: string) =>
      eventId === NEW || eventId === correctedSlot?.root.id
        ? newEvent
        : slots.find((s) => s.root.id === eventId)!.event;

    for (const posted of toReverse) {
      const original = await tx.ledgerEntry.findUniqueOrThrow({ where: { id: posted.entryId } });
      await tx.ledgerEntry.create({
        data: {
          policyId,
          kind: "REVERSAL",
          amountCents: -original.amountCents,
          description: `Reversal: ${original.description}`,
          postedByTransactionId: transaction.id,
          originTransactionId: original.originTransactionId,
          reversesEntryId: original.id,
          coverageCode: original.coverageCode,
          calc: original.calc ?? undefined,
        },
      });
    }
    for (const line of toPost) {
      await tx.ledgerEntry.create({
        data: entryData(policyId, transaction.id, originFor(line.eventId), line, describe(line, eventFor(line.eventId))),
      });
    }

    await tx.policy.update({
      where: { id: policyId },
      data: {
        startDate: toJSDate(state.startDate),
        endDate: toJSDate(state.endDate),
        status: state.cancelledEffective ? "CANCELLED" : "ACTIVE",
        cancelledEffective: state.cancelledEffective ? toJSDate(state.cancelledEffective) : null,
      },
    });

    return { transaction, preview };
  });
}

type Plan = {
  slots: Slot[];
  state: PolicyState;
  newEvent: PolicyEvent;
  correctedSlot: Slot | null;
  toReverse: PostedLine[];
  toPost: PremiumLine[];
  preview: ChangePreview;
};

async function plan(tx: Tx, policyId: string, request: ChangeRequest): Promise<Plan> {
  const transactions = await tx.policyTransaction.findMany({ where: { policyId }, orderBy: { seq: "asc" } });
  if (transactions.length === 0) throw new PolicyRuleError("Policy not found.");
  const slots = buildSlots(transactions);
  const rootOf = rootIdByTransaction(slots);

  let history: HistoryItem[];
  let newEvent: PolicyEvent;
  let correctedSlot: Slot | null = null;

  if (request.kind === "CORRECTION") {
    const rootId = rootOf.get(request.transactionId);
    correctedSlot = slots.find((s) => s.root.id === rootId) ?? null;
    if (!correctedSlot) throw new PolicyRuleError("That action can't be corrected.");
    newEvent = correctedEvent(correctedSlot.event, request.event);
    history = toHistory(slots).map((item) =>
      item.id === correctedSlot!.root.id ? { ...item, event: newEvent } : item,
    );
  } else {
    newEvent =
      request.kind === "COVERAGE_CHANGE"
        ? {
            type: "COVERAGE_CHANGE",
            effectiveDate: request.effectiveDate,
            add: request.add.map(rateFor),
            remove: request.remove,
          }
        : { type: "CANCELLATION", effectiveDate: request.effectiveDate };
    history = [...toHistory(slots), { id: NEW, event: newEvent }];
  }

  let state: PolicyState;
  try {
    state = replay(history);
  } catch (error) {
    throw friendlier(error, correctedSlot, slots);
  }

  // What is on the statement now: premium lines that haven't been reversed.
  const entries = await tx.ledgerEntry.findMany({
    where: { policyId, kind: { in: ["CHARGE", "CREDIT"] }, reversedBy: null },
    orderBy: { seq: "asc" },
  });
  const posted: PostedLine[] = entries.map((e) => {
    const calc = e.calc as LineCalc;
    return {
      entryId: e.id,
      eventId: rootOf.get(e.originTransactionId!)!,
      coverageCode: e.coverageCode!,
      kind: e.kind as "CHARGE" | "CREDIT",
      amountCents: e.amountCents,
      ...calc,
    };
  });

  // Lines for the new action carry the placeholder id, so they never match a posted line.
  const { toReverse, toPost, netChangeCents } = planCorrection(posted, allLines(state));
  if (correctedSlot && toReverse.length === 0 && toPost.length === 0) {
    throw new PolicyRuleError("That correction doesn't change anything.");
  }

  const balance = await tx.ledgerEntry.aggregate({ where: { policyId }, _sum: { amountCents: true } });
  const balanceBeforeCents = balance._sum.amountCents ?? 0;
  const descriptionOf = new Map(entries.map((e) => [e.id, e.description]));
  const eventFor = (eventId: string) =>
    eventId === NEW || eventId === correctedSlot?.root.id
      ? newEvent
      : slots.find((s) => s.root.id === eventId)!.event;

  return {
    slots,
    state,
    newEvent,
    correctedSlot,
    toReverse,
    toPost,
    preview: {
      reversals: toReverse.map((l) => ({
        coverageCode: l.coverageCode,
        description: `Reversal: ${descriptionOf.get(l.entryId)}`,
        amountCents: -l.amountCents,
        calc: calcOf(l),
      })),
      postings: toPost.map((l) => ({
        coverageCode: l.coverageCode,
        description: describe(l, eventFor(l.eventId)),
        amountCents: l.amountCents,
        calc: calcOf(l),
      })),
      netChangeCents,
      balanceBeforeCents,
      balanceAfterCents: balanceBeforeCents + netChangeCents,
    },
  };
}

/** Merges the broker's correction into the original event, keeping what can't change. */
function correctedEvent(original: PolicyEvent, input: CorrectedEvent): PolicyEvent {
  if (original.type !== input.type) throw new PolicyRuleError("A correction can't change the kind of action.");
  if (original.type === "ISSUE" && input.type === "ISSUE") {
    // Keep the price each coverage was issued at; price new ones from the rate table.
    const coverages = input.coverages.map(
      (code) => original.coverages.find((c) => c.code === code) ?? rateFor(code),
    );
    return { type: "ISSUE", startDate: input.startDate, endDate: addOneYear(input.startDate), coverages };
  }
  if (original.type === "COVERAGE_CHANGE" && input.type === "COVERAGE_CHANGE") {
    const add = input.add.map((code) => original.add.find((c) => c.code === code) ?? rateFor(code));
    return { type: "COVERAGE_CHANGE", effectiveDate: input.effectiveDate, add, remove: input.remove };
  }
  if (input.type === "CANCELLATION") return { type: "CANCELLATION", effectiveDate: input.effectiveDate };
  throw new PolicyRuleError("That correction isn't supported.");
}

/** If a correction breaks a *later* action, say which one. */
function friendlier(error: unknown, correctedSlot: Slot | null, slots: Slot[]) {
  if (!(error instanceof PolicyRuleError) || !correctedSlot) return error;
  if (!error.eventId || error.eventId === correctedSlot.root.id) return error;
  const later = slots.find((s) => s.root.id === error.eventId);
  if (!later) return error;
  return new PolicyRuleError(
    `This correction conflicts with a later change (#${later.root.seq}): ${error.message} Correct that change first.`,
    error.eventId,
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const calcOf = (l: PremiumLine): LineCalc => ({
  annualPremiumCents: l.annualPremiumCents,
  days: l.days,
  termDays: l.termDays,
  from: l.from,
  to: l.to,
});

function entryData(
  policyId: string,
  postedByTransactionId: string,
  originTransactionId: string,
  line: PremiumLine,
  description: string,
): Prisma.LedgerEntryUncheckedCreateInput {
  return {
    policyId,
    kind: line.kind,
    amountCents: line.amountCents,
    description,
    postedByTransactionId,
    originTransactionId,
    coverageCode: line.coverageCode,
    calc: calcOf(line),
  };
}

/** The wording of a statement line. */
function describe(line: PremiumLine, event: PolicyEvent): string {
  const name = coverageName(line.coverageCode);
  if (event.type === "ISSUE") return `${name}: policy issued, full term`;
  if (event.type === "CANCELLATION") {
    return `${name}: unused days after cancellation on ${formatDate(event.effectiveDate)}`;
  }
  return line.kind === "CHARGE"
    ? `${name}: added from ${formatDate(event.effectiveDate)}`
    : `${name}: removed from ${formatDate(event.effectiveDate)}`;
}
