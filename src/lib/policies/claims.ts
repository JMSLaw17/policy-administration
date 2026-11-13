import "server-only";
import { db } from "@/lib/db";
import {
  CLAIM_DEDUCTIBLE_CENTS,
  claimPayout,
  coverageName,
  formatDate,
  formatUSD,
  fromJSDate,
  getCoverage,
  isCoveredOn,
  MAX_CLAIM_CENTS,
  PolicyRuleError,
  replay,
  toJSDate,
  todayISO,
  type ISODate,
} from "@/lib/engine";
import { buildSlots, toHistory } from "./history";

/**
 * Claims: file -> approve or deny -> pay.
 *
 *  - A claim is only accepted if its coverage was in force on the date of
 *    loss, judged by the policy's history as it stands (so corrections and
 *    cancellations count).
 *  - Approving fixes the terms: payout = approved loss − deductible, capped at
 *    the coverage's per-claim limit. The inputs are stored with the claim.
 *  - Claim money goes from the insurer to the customer. It is not premium, so
 *    it never touches the premium statement or the amount due.
 *
 * Simulated: paying a claim records the payment here; no money moves.
 */

async function policyState(policyId: string) {
  const transactions = await db.policyTransaction.findMany({ where: { policyId }, orderBy: { seq: "asc" } });
  if (transactions.length === 0) throw new PolicyRuleError("Policy not found.");
  return replay(toHistory(buildSlots(transactions)));
}

export async function fileClaim(input: {
  policyId: string;
  coverageCode: string;
  lossDate: ISODate;
  description: string;
  claimedCents: number;
  userId: string;
}) {
  const coverage = getCoverage(input.coverageCode);
  if (input.lossDate > todayISO()) throw new PolicyRuleError("The date of loss can't be in the future.");
  if (!Number.isInteger(input.claimedCents) || input.claimedCents <= 0) {
    throw new PolicyRuleError("Enter the amount of the loss.");
  }
  if (input.claimedCents > MAX_CLAIM_CENTS) {
    throw new PolicyRuleError(
      `The largest loss that can be entered is ${formatUSD(MAX_CLAIM_CENTS)}. For a larger loss, enter ${formatUSD(MAX_CLAIM_CENTS)} and give the full figure in the description. The payout is the same either way, because ${coverage.name} pays at most ${formatUSD(coverage.limitCents)} for one claim.`,
    );
  }
  const state = await policyState(input.policyId);
  if (!isCoveredOn(state, coverage.code, input.lossDate)) {
    throw new PolicyRuleError(
      `${coverage.name} wasn't in force on ${formatDate(input.lossDate)}, so this loss isn't covered by the policy.`,
    );
  }
  // The number comes from a database counter (a Postgres sequence), which never hands out
  // the same one twice, so claims filed at the same moment can't collide. As with policy
  // numbers, a number is used up even if filing then fails, so there can be gaps.
  const [{ next }] = await db.$queryRaw<{ next: bigint }[]>`SELECT nextval('"claim_number_seq"') AS next`;
  return db.claim.create({
    data: {
      claimNumber: `CLM-${input.lossDate.slice(0, 4)}-${String(next).padStart(4, "0")}`,
      policyId: input.policyId,
      coverageCode: coverage.code,
      lossDate: toJSDate(input.lossDate),
      description: input.description,
      claimedCents: input.claimedCents,
      filedById: input.userId,
    },
  });
}

export type ClaimDecision =
  | { decision: "APPROVE"; approvedLossCents: number; note?: string }
  | { decision: "DENY"; note: string };

export async function decideClaim(claimId: string, decision: ClaimDecision, userId: string) {
  const claim = await db.claim.findUniqueOrThrow({ where: { id: claimId } });
  const alreadyDecided = () => new PolicyRuleError("This claim has already been decided.");
  if (claim.status !== "SUBMITTED") throw alreadyDecided();

  // The decision is written only if the claim is still waiting for one, and that check is
  // part of the write. Two brokers deciding at the same moment can't both succeed: the
  // second finds nothing to update and is told the claim has been decided.
  const decide = async (data: Parameters<typeof db.claim.updateMany>[0]["data"]) => {
    const { count } = await db.claim.updateMany({ where: { id: claimId, status: "SUBMITTED" }, data });
    if (count !== 1) throw alreadyDecided();
    return db.claim.findUniqueOrThrow({ where: { id: claimId } });
  };

  if (decision.decision === "DENY") {
    if (!decision.note.trim()) throw new PolicyRuleError("Give the reason for denying the claim.");
    return decide({ status: "DENIED", decisionNote: decision.note.trim(), decidedById: userId, decidedAt: new Date() });
  }

  const approved = decision.approvedLossCents;
  if (!Number.isInteger(approved) || approved <= 0) throw new PolicyRuleError("Enter the approved loss.");
  if (approved > claim.claimedCents) {
    throw new PolicyRuleError(`The approved loss can't be more than the ${formatUSD(claim.claimedCents)} claimed.`);
  }
  // Re-check coverage: the policy may have been corrected or cancelled since the claim was filed.
  const lossDate = fromJSDate(claim.lossDate);
  if (!isCoveredOn(await policyState(claim.policyId), claim.coverageCode, lossDate)) {
    throw new PolicyRuleError(
      `${coverageName(claim.coverageCode)} is no longer in force on ${formatDate(lossDate)} after changes to the policy. Deny the claim, or correct the policy first.`,
    );
  }
  const limitCents = getCoverage(claim.coverageCode).limitCents;
  return decide({
    status: "APPROVED",
    approvedLossCents: approved,
    deductibleCents: CLAIM_DEDUCTIBLE_CENTS,
    limitCents,
    payoutCents: claimPayout(approved, CLAIM_DEDUCTIBLE_CENTS, limitCents),
    decisionNote: decision.note?.trim() || null,
    decidedById: userId,
    decidedAt: new Date(),
  });
}

export async function payClaim(claimId: string) {
  // The status check is part of the update, so a claim can't be paid twice.
  const { count } = await db.claim.updateMany({
    where: { id: claimId, status: "APPROVED" },
    data: { status: "PAID", paidAt: new Date() },
  });
  if (count === 0) throw new PolicyRuleError("Only an approved claim that hasn't been paid can be paid.");
  return db.claim.findUniqueOrThrow({ where: { id: claimId } });
}

export type ClaimView = Awaited<ReturnType<typeof claimsForPolicy>>[number];

export async function claimsForPolicy(policyId: string) {
  const [claims, state] = await Promise.all([
    db.claim.findMany({
      where: { policyId },
      orderBy: { filedAt: "desc" },
      include: { filedBy: { select: { name: true } }, decidedBy: { select: { name: true } } },
    }),
    policyState(policyId),
  ]);
  return claims.map((c) => {
    const lossDate = fromJSDate(c.lossDate);
    return {
      id: c.id,
      claimNumber: c.claimNumber,
      coverageCode: c.coverageCode,
      lossDate,
      description: c.description,
      claimedCents: c.claimedCents,
      status: c.status,
      approvedLossCents: c.approvedLossCents,
      deductibleCents: c.deductibleCents,
      limitCents: c.limitCents,
      payoutCents: c.payoutCents,
      decisionNote: c.decisionNote,
      filedBy: c.filedBy.name,
      filedAt: c.filedAt.toISOString(),
      decidedBy: c.decidedBy?.name ?? null,
      decidedAt: c.decidedAt?.toISOString() ?? null,
      paidAt: c.paidAt?.toISOString() ?? null,
      /** False if a later correction or cancellation took the coverage off the loss date. */
      stillCovered: isCoveredOn(state, c.coverageCode, lossDate),
    };
  });
}
