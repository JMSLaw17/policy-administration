"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { COVERAGES, formatUSD, isISODate, MAX_CLAIM_CENTS, parseUSD, PolicyRuleError } from "@/lib/engine";
import { decideClaim, fileClaim, payClaim } from "@/lib/policies/claims";

export type ClaimFormState = { error?: string; saved?: string } | undefined;

function revalidate(policyId: string) {
  revalidatePath(`/broker/policies/${policyId}`);
  revalidatePath(`/portal/policies/${policyId}`);
}

const dollars = (label: string) =>
  z
    .string()
    .transform((value) => parseUSD(value))
    .refine((cents): cents is number => cents !== null && cents > 0, `Enter ${label} in dollars, such as 4,000.`)
    // Checked here as well as in the claim rules, so an amount too large to store never reaches the database.
    .refine((cents) => cents <= MAX_CLAIM_CENTS, `The largest amount that can be entered is ${formatUSD(MAX_CLAIM_CENTS)}.`);

const FileSchema = z.object({
  policyId: z.string().min(1),
  coverageCode: z.enum(COVERAGES.map((c) => c.code) as [string, ...string[]]),
  lossDate: z.string().refine(isISODate, "Enter the date of the loss."),
  description: z.string().trim().min(5, "Describe what happened.").max(1000),
  claimed: dollars("the amount of the loss"),
});

/** Either role can file: a policyholder on their own policy, a broker on any. */
export async function fileClaimAction(_prev: ClaimFormState, formData: FormData): Promise<ClaimFormState> {
  const user = await requireUser();
  const parsed = FileSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const policy = await db.policy.findUnique({ where: { id: parsed.data.policyId }, select: { customerId: true } });
  if (!policy || (user.role === "POLICYHOLDER" && policy.customerId !== user.customerId)) {
    return { error: "Policy not found." };
  }
  try {
    const claim = await fileClaim({
      policyId: parsed.data.policyId,
      coverageCode: parsed.data.coverageCode,
      lossDate: parsed.data.lossDate,
      description: parsed.data.description,
      claimedCents: parsed.data.claimed,
      userId: user.id,
    });
    revalidate(parsed.data.policyId);
    return {
      saved:
        user.role === "BROKER"
          ? `Claim ${claim.claimNumber} filed. It's ready for your decision.`
          : `Claim ${claim.claimNumber} filed. Your broker will review it.`,
    };
  } catch (error) {
    if (error instanceof PolicyRuleError) return { error: error.message };
    throw error;
  }
}

const DecideSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("APPROVE"),
    claimId: z.string().min(1),
    approved: dollars("the approved loss"),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    decision: z.literal("DENY"),
    claimId: z.string().min(1),
    note: z.string().trim().min(1, "Give the reason for denying the claim.").max(500),
  }),
]);

export async function decideClaimAction(_prev: ClaimFormState, formData: FormData): Promise<ClaimFormState> {
  const user = await requireUser("BROKER");
  const parsed = DecideSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const claim = await decideClaim(
      parsed.data.claimId,
      parsed.data.decision === "APPROVE"
        ? { decision: "APPROVE", approvedLossCents: parsed.data.approved, note: parsed.data.note }
        : { decision: "DENY", note: parsed.data.note },
      user.id,
    );
    revalidate(claim.policyId);
  } catch (error) {
    if (error instanceof PolicyRuleError) return { error: error.message };
    throw error;
  }
}

export async function payClaimAction(claimId: string): Promise<ClaimFormState> {
  await requireUser("BROKER");
  try {
    const claim = await payClaim(claimId);
    revalidate(claim.policyId);
  } catch (error) {
    if (error instanceof PolicyRuleError) return { error: error.message };
    throw error;
  }
}
