import "server-only";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  addOneYear,
  allLines,
  COMMISSION_RATE_BPS,
  coverageName,
  daysBetween,
  formatDate,
  fromJSDate,
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
 *
 * A policy and its renewal are separate policies, but their dates are tied:
 * the renewal's term must never overlap the term it renews, and a gap between
 * them is only allowed on purpose. See "A policy and its renewal" below.
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
  /** See PremiumLine.roundingCents. */
  roundingCents?: number;
};

/** What an action does to one policy's statement. */
export type StatementEffect = {
  /** Lines on the statement that will be reversed, with the reversing amount. */
  reversals: PlannedLine[];
  /** New lines that will be posted. */
  postings: PlannedLine[];
  netChangeCents: number;
  balanceBeforeCents: number;
  balanceAfterCents: number;
};

export type ChangePreview = StatementEffect & {
  /** Set when the action moves the end of this policy's cover and it has a renewal. */
  renewal: RenewalEffect | null;
  /** Set when the action leaves days without cover between this policy and the one it renews. */
  gapAfterOriginal: (Gap & { policyId: string; policyNumber: string }) | null;
  /** True when the action, as chosen, leaves a gap. A gap can only be saved with a reason. */
  reasonRequired: boolean;
  /**
   * The money this action moves, as one string. The broker's confirmation
   * sends it back, and the change is only saved if it still matches.
   */
  fingerprint: string;
};

/** Thrown when the figures the broker previewed are no longer what the action would do. */
export class PreviewChangedError extends Error {
  constructor(public preview: ChangePreview) {
    super(
      "The figures have changed since you previewed this, because something else happened on the policy in the meantime (a payment or refund, or another change). Check the new figures below and confirm again.",
    );
  }
}

/**
 * Everything the broker was shown and is agreeing to:
 *  - the money: each policy's lines, and its balance before and after;
 *  - the dates: where each policy's term and cover end up;
 *  - the renewal: what was chosen for it, and any days left without cover.
 *
 * A gap is not money, but it is what the broker is asked to give a reason
 * for. If the renewal has been moved since the preview, the gap being
 * confirmed is a different one, so it is part of the fingerprint too.
 */
function fingerprintOf(
  steps: Step[],
  renewal: RenewalEffect | null,
  gapAfterOriginal: ChangePreview["gapAfterOriginal"],
): string {
  const line = (l: PlannedLine) => [l.description, l.amountCents];
  const gap = (g: Gap | null) => g && [g.from, g.to, g.days];
  return JSON.stringify({
    policies: steps.map((s) => [
      s.policyId,
      s.planned.preview.balanceBeforeCents,
      s.planned.preview.balanceAfterCents,
      s.planned.preview.reversals.map(line),
      s.planned.preview.postings.map(line),
      s.planned.state.startDate,
      s.planned.state.endDate,
      s.planned.state.cancelledEffective,
    ]),
    renewal: renewal && [renewal.policyId, renewal.chosen, renewal.choices, gap(renewal.gapIfKept)],
    gapAfterOriginal: gapAfterOriginal && [gapAfterOriginal.policyId, gap(gapAfterOriginal)],
  });
}

/** Days with no cover: from `from` up to, not including, `to`. */
export type Gap = { from: ISODate; to: ISODate; days: number };

/**
 * What to do with a policy's renewal when the end of the policy's cover moves:
 *  - FOLLOW: the renewal moves with it (or is cancelled with it), so there is
 *    no gap and no overlap. This is the default.
 *  - KEEP: the renewal stays where it is, leaving a gap. Needs a reason, and
 *    is never allowed if it would make the two policies overlap.
 */
export type RenewalChoice = "FOLLOW" | "KEEP";

export type RenewalEffect = {
  policyId: string;
  policyNumber: string;
  /** The options open to the broker. Never empty. */
  choices: RenewalChoice[];
  chosen: RenewalChoice;
  /** What FOLLOW does to the renewal, and to any renewals after it. Empty if it can't follow. */
  follow: FollowStep[];
  /** Why the renewal can't follow, if it can't. */
  followBlocked: string | null;
  /** The days KEEP would leave without cover. Null if KEEP isn't allowed. */
  gapIfKept: Gap | null;
};

export type FollowStep = StatementEffect & {
  policyId: string;
  policyNumber: string;
  action: "MOVE" | "CANCEL";
  /** Plain-English account of what happens to this policy. */
  summary: string;
};

export type ChangeRequest = (
  | { kind: "COVERAGE_CHANGE"; effectiveDate: ISODate; add: string[]; remove: string[] }
  | { kind: "CANCELLATION"; effectiveDate: ISODate }
  | { kind: "CORRECTION"; transactionId: string; event: CorrectedEvent }
) & { reason?: string; renewal?: RenewalChoice };

/** What the broker can change when correcting an action. */
export type CorrectedEvent =
  | { type: "ISSUE"; startDate: ISODate; coverages: string[] }
  | { type: "COVERAGE_CHANGE"; effectiveDate: ISODate; add: string[]; remove: string[] }
  | { type: "CANCELLATION"; effectiveDate: ISODate };

const rateFor = (code: string) => ({ code, annualPremiumCents: getCoverage(code).annualPremiumCents });

/* ------------------------------------------------------------------ */
/* Issue                                                               */
/* ------------------------------------------------------------------ */

type IssueInput = {
  customerId: string;
  startDate: ISODate;
  coverageCodes: string[];
  /**
   * The annual price of each coverage, when the prices were agreed beforehand
   * (on a signed application). Left out, today's rate table is used.
   */
  rates?: { code: string; annualPremiumCents: number }[];
  userId: string;
  /** Set when this policy renews an earlier one. */
  renewedFromId?: string;
};

export async function issuePolicy(input: IssueInput) {
  return db.$transaction((tx) => issuePolicyIn(tx, input));
}

/**
 * Issues a policy as part of a transaction the caller already has open, so the
 * policy and whatever it is issued from (a signed application) are saved
 * together or not at all.
 */
export async function issuePolicyIn(tx: Tx, input: IssueInput) {
  const event: PolicyEvent = {
    type: "ISSUE",
    startDate: input.startDate,
    endDate: addOneYear(input.startDate),
    coverages: input.rates ?? input.coverageCodes.map(rateFor),
  };
  // Validates the event and gives us the charge lines.
  const state = replay([{ id: NEW, event }]);

  const policy = await tx.policy.create({
    data: {
      policyNumber: await nextPolicyNumber(tx, input.startDate),
      customerId: input.customerId,
      productCode: "SBP",
      commissionRateBps: COMMISSION_RATE_BPS,
      renewedFromId: input.renewedFromId ?? null,
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
}

/**
 * Policy numbers come from a database counter (a Postgres sequence), which
 * never hands out the same number twice, even to two policies issued at the
 * same moment. A number is used up even if issuing then fails, so the numbers
 * are unique but can have gaps.
 */
async function nextPolicyNumber(tx: Tx, startDate: ISODate) {
  const [{ next }] = await tx.$queryRaw<{ next: bigint }[]>`SELECT nextval('"policy_number_seq"') AS next`;
  return `SBP-${startDate.slice(0, 4)}-${String(next).padStart(4, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Edit coverage, cancel, correct                                      */
/* ------------------------------------------------------------------ */

/** Shows what an action would do to the statement, without saving anything. */
export async function previewChange(policyId: string, request: ChangeRequest): Promise<ChangePreview> {
  return db.$transaction(async (tx) => (await planWithRenewal(tx, policyId, request)).preview);
}

/**
 * Saves the action and posts its lines to the statement. If the action moves
 * this policy's renewal as well, both are saved together or not at all.
 *
 * `affected` lists every policy that was changed, this one first.
 */
export async function applyChange(
  policyId: string,
  request: ChangeRequest,
  userId: string,
  /** The fingerprint of the preview the broker confirmed. If the figures have moved since, nothing is saved. */
  previewed?: string,
) {
  return db.$transaction(async (tx) => {
    // One change at a time per policy and its renewals, so two brokers can't
    // post from the same starting point.
    await lockChain(tx, policyId);
    const { steps, preview } = await planWithRenewal(tx, policyId, request);
    if (previewed !== undefined && previewed !== preview.fingerprint) throw new PreviewChangedError(preview);
    if (preview.reasonRequired && !request.reason?.trim()) {
      throw new PolicyRuleError("This leaves days without coverage, so it needs a reason. Enter one to confirm.");
    }

    const transactions: Awaited<ReturnType<typeof post>>[] = [];
    for (const step of steps) transactions.push(await post(tx, step, userId));
    for (const note of gapNotes(steps[0], preview, request.reason)) {
      await postNote(tx, note, userId);
    }

    return {
      transaction: transactions[0],
      preview,
      affected: steps.map((step, i) => ({ policyId: step.policyId, transactionId: transactions[i].id })),
    };
  });
}

/** One policy's part of a change: the policy, the request made of it, and what that does. */
type Step = { policyId: string; policyNumber: string; request: ChangeRequest; planned: Plan };

/** Writes one step: the history entry, its reversals, and its new lines. */
async function post(tx: Tx, step: Step, userId: string) {
  const { policyId, request } = step;
  const { slots, state, newEvent, correctedSlot, toReverse, toPost } = step.planned;

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

  return transaction;
}

/* ------------------------------------------------------------------ */
/* A policy and its renewal                                            */
/* ------------------------------------------------------------------ */

/**
 * A renewal is a separate policy that picks up where the one before it ends.
 * Two rules tie their dates together:
 *
 *  1. They never overlap. An overlap would charge the customer twice for the
 *     same days and put a claim on those days under two policies.
 *  2. A gap between them (days with no cover) is allowed only on purpose: the
 *     broker has to choose it and give a reason. Lapses do happen.
 *
 * So when an action moves the end of a policy's cover (a corrected start
 * date, a cancellation, a corrected cancellation date), its renewal follows
 * by default: it is moved to start the day the policy now ends, or cancelled
 * from its first day if the policy was cancelled. The renewal's own renewal
 * follows in turn. The broker can instead keep the renewal where it is, if
 * that leaves a gap rather than an overlap.
 *
 * And when an action moves a renewal's own start date, it may not move into
 * the term it renews, and moving it later needs a reason.
 */

/** The days a policy actually covers: from `start` up to, not including, `coverEnd`. */
type Span = { start: ISODate; coverEnd: ISODate };

type PolicyDates = { startDate: Date; endDate: Date; cancelledEffective: Date | null };
const spanOfRow = (p: PolicyDates): Span => ({
  start: fromJSDate(p.startDate),
  coverEnd: fromJSDate(p.cancelledEffective ?? p.endDate),
});
const spanOfState = (s: PolicyState): Span => ({ start: s.startDate, coverEnd: s.cancelledEffective ?? s.endDate });
/** False for a policy cancelled from its first day, which covers nothing. */
const hasDays = (span: Span) => span.start < span.coverEnd;
const gapBetween = (from: ISODate, to: ISODate): Gap => ({ from, to, days: daysBetween(from, to) });

const linked = { id: true, policyNumber: true, startDate: true, endDate: true, cancelledEffective: true } as const;

/**
 * Plans an action on a policy together with what it means for the policies
 * linked to it. `asFollower` is set when this policy is itself being moved to
 * follow the one it renews, whose new dates aren't saved yet.
 */
async function planWithRenewal(
  tx: Tx,
  policyId: string,
  request: ChangeRequest,
  asFollower = false,
): Promise<{ steps: Step[]; preview: ChangePreview }> {
  const policy = await tx.policy.findUnique({
    where: { id: policyId },
    select: { ...linked, renewedFrom: { select: linked }, renewal: { select: linked } },
  });
  if (!policy) throw new PolicyRuleError("Policy not found.");

  const planned = await plan(tx, policyId, request);
  const before = spanOfRow(policy);
  const after = spanOfState(planned.state);
  const steps: Step[] = [{ policyId, policyNumber: policy.policyNumber, request, planned }];

  // Looking back: has this policy's first day moved relative to the one it renews?
  let gapAfterOriginal: ChangePreview["gapAfterOriginal"] = null;
  const original = policy.renewedFrom;
  if (original && !asFollower && hasDays(after) && (after.start !== before.start || !hasDays(before))) {
    const originalEnd = spanOfRow(original).coverEnd;
    if (after.start < originalEnd) {
      throw new PolicyRuleError(
        `This policy renews ${original.policyNumber}, which is in force until ${formatDate(originalEnd)}, so it can't start before then. Two policies can't cover the same days. To move both, correct the dates on ${original.policyNumber} and this policy will follow.`,
      );
    }
    if (after.start > originalEnd) {
      gapAfterOriginal = {
        policyId: original.id,
        policyNumber: original.policyNumber,
        ...gapBetween(originalEnd, after.start),
      };
    }
  }

  // Looking forward: has the end of this policy's cover moved away from its renewal's first day?
  let renewal: RenewalEffect | null = null;
  const next = policy.renewal;
  if (next && hasDays(spanOfRow(next)) && after.coverEnd !== before.coverEnd) {
    const nextStart = spanOfRow(next).start;
    if (nextStart !== after.coverEnd) {
      let follow: Step[] = [];
      let followBlocked: string | null = null;
      try {
        const followRequest = await requestToFollow(tx, next.id, policy.policyNumber, planned.state, request.reason);
        follow = (await planWithRenewal(tx, next.id, followRequest, true)).steps;
      } catch (error) {
        if (!(error instanceof PolicyRuleError)) throw error;
        followBlocked = error.message;
      }

      const overlapIfKept = nextStart < after.coverEnd;
      const choices: RenewalChoice[] = [];
      if (follow.length > 0) choices.push("FOLLOW");
      if (!overlapIfKept) choices.push("KEEP");
      if (choices.length === 0) {
        throw new PolicyRuleError(
          `This would make the policy overlap with its renewal ${next.policyNumber}, which starts ${formatDate(nextStart)}, and the renewal can't be moved with it: ${followBlocked}`,
        );
      }
      if (request.renewal && !choices.includes(request.renewal)) {
        throw new PolicyRuleError(
          request.renewal === "KEEP"
            ? `The renewal ${next.policyNumber} can't stay where it is, because the two policies would both cover ${formatDate(nextStart)} to ${formatDate(after.coverEnd)}.`
            : `The renewal ${next.policyNumber} can't follow this change: ${followBlocked}`,
        );
      }
      // Follow by default. But a renewal that was already standing apart was
      // left there on purpose, so it stays put unless the broker says otherwise.
      const alreadyApart = nextStart !== before.coverEnd;
      const chosen = request.renewal ?? (alreadyApart && choices.includes("KEEP") ? "KEEP" : choices[0]);
      if (chosen === "FOLLOW") steps.push(...follow);

      renewal = {
        policyId: next.id,
        policyNumber: next.policyNumber,
        choices,
        chosen,
        follow: follow.map(followStep),
        followBlocked,
        gapIfKept: overlapIfKept ? null : gapBetween(after.coverEnd, nextStart),
      };
    }
  }

  return {
    steps,
    preview: {
      ...planned.preview,
      renewal,
      gapAfterOriginal,
      reasonRequired: Boolean(gapAfterOriginal || (renewal?.chosen === "KEEP" && renewal.gapIfKept)),
      fingerprint: fingerprintOf(steps, renewal, gapAfterOriginal),
    },
  };
}

/**
 * The request that makes a renewal follow the policy it renews: start the day
 * that policy now ends, or, if that policy has been cancelled, be cancelled
 * from its own first day.
 */
async function requestToFollow(
  tx: Tx,
  renewalId: string,
  leaderNumber: string,
  leader: PolicyState,
  brokerReason: string | undefined,
): Promise<ChangeRequest> {
  const transactions = await tx.policyTransaction.findMany({ where: { policyId: renewalId }, orderBy: { seq: "asc" } });
  const slots = buildSlots(transactions);
  const issue = slots.find((s) => s.event.type === "ISSUE");
  if (!issue || issue.event.type !== "ISSUE") throw new PolicyRuleError("Policy not found.");
  const given = brokerReason?.trim() ? ` Reason given: ${brokerReason.trim()}` : "";

  if (leader.cancelledEffective) {
    const reason = `Cancelled together with ${leaderNumber}, the policy it renews.${given}`;
    const effectiveDate = issue.event.startDate;
    const cancellation = slots.find((s) => s.event.type === "CANCELLATION");
    return cancellation
      ? { kind: "CORRECTION", transactionId: cancellation.root.id, event: { type: "CANCELLATION", effectiveDate }, reason, renewal: "FOLLOW" }
      : { kind: "CANCELLATION", effectiveDate, reason, renewal: "FOLLOW" };
  }
  return {
    kind: "CORRECTION",
    transactionId: issue.root.id,
    event: { type: "ISSUE", startDate: leader.endDate, coverages: issue.event.coverages.map((c) => c.code) },
    reason: `Moved to follow ${leaderNumber}, which now ends ${formatDate(leader.endDate)}.${given}`,
    renewal: "FOLLOW",
  };
}

function followStep(step: Step): FollowStep {
  const { state, preview } = step.planned;
  const cancelled = step.request.kind === "CANCELLATION" || state.cancelledEffective === state.startDate;
  return {
    ...preview,
    policyId: step.policyId,
    policyNumber: step.policyNumber,
    action: cancelled ? "CANCEL" : "MOVE",
    summary: cancelled
      ? `Cancelled from its first day, ${formatDate(state.startDate)}, so nothing is owed on it.`
      : `Moves to ${formatDate(state.startDate)} to ${formatDate(state.endDate)}.`,
  };
}

/** Locks a policy, the policies it renews, and its renewals, always in the same order. */
export async function lockChain(tx: Tx, policyId: string) {
  let first = policyId;
  for (;;) {
    const p = await tx.policy.findUnique({ where: { id: first }, select: { renewedFromId: true } });
    if (!p?.renewedFromId) break;
    first = p.renewedFromId;
  }
  for (let id: string | null = first; id; ) {
    await tx.$queryRaw`SELECT id FROM "Policy" WHERE id = ${id} FOR UPDATE`;
    const next: { id: string } | null = await tx.policy.findUnique({ where: { renewedFromId: id }, select: { id: true } });
    id = next?.id ?? null;
  }
}

/** A gap is written into the history of both policies it sits between. */
type GapNote = { policyId: string; effectiveDate: ISODate; note: string };

function gapNotes(changed: Step, preview: ChangePreview, reason: string | undefined): GapNote[] {
  const { policyId, policyNumber } = changed;
  const why = reason?.trim() ? ` Reason: ${reason.trim()}` : "";
  const text = (gap: Gap, earlier: string, later: string) =>
    `No coverage from ${formatDate(gap.from)} to ${formatDate(gap.to)} (${gap.days} ${gap.days === 1 ? "day" : "days"}), between ${earlier} and its renewal ${later}.${why}`;

  const notes: GapNote[] = [];
  const back = preview.gapAfterOriginal;
  if (back) {
    const note = text(back, back.policyNumber, policyNumber);
    notes.push({ policyId, effectiveDate: back.from, note });
    notes.push({ policyId: back.policyId, effectiveDate: back.from, note });
  }
  const forward = preview.renewal;
  if (forward?.chosen === "KEEP" && forward.gapIfKept) {
    const note = text(forward.gapIfKept, policyNumber, forward.policyNumber);
    notes.push({ policyId, effectiveDate: forward.gapIfKept.from, note });
    notes.push({ policyId: forward.policyId, effectiveDate: forward.gapIfKept.from, note });
  }
  return notes;
}

/** A history entry that records a fact without changing any amount. */
async function postNote(tx: Tx, note: GapNote, userId: string) {
  const last = await tx.policyTransaction.aggregate({ where: { policyId: note.policyId }, _max: { seq: true } });
  await tx.policyTransaction.create({
    data: {
      policyId: note.policyId,
      seq: (last._max.seq ?? 0) + 1,
      type: "NOTE",
      effectiveDate: toJSDate(note.effectiveDate),
      data: { title: "Gap in coverage", note: note.note },
      createdById: userId,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Planning one policy's change                                        */
/* ------------------------------------------------------------------ */

type Plan = {
  slots: Slot[];
  state: PolicyState;
  newEvent: PolicyEvent;
  correctedSlot: Slot | null;
  toReverse: PostedLine[];
  toPost: PremiumLine[];
  preview: StatementEffect;
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
  ...(l.roundingCents ? { roundingCents: l.roundingCents } : {}),
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
  if (event.type === "ISSUE") return `${name}: full term`;
  if (event.type === "CANCELLATION") {
    return `${name}: unused days after cancellation on ${formatDate(event.effectiveDate)}`;
  }
  return line.kind === "CHARGE"
    ? `${name}: added from ${formatDate(event.effectiveDate)}`
    : `${name}: removed from ${formatDate(event.effectiveDate)}`;
}
