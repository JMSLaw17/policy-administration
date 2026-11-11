"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { StripeNotConfiguredError } from "@/lib/integrations/stripe";
import { PaymentError, reconcilePending, startPayment } from "@/lib/policies/payments";

export type StartPaymentResult =
  | { ok: true; clientSecret: string; amountCents: number }
  | { ok: false; error: string };

/** A policyholder may only act on their own policies. */
async function requireOwnPolicy(policyId: string) {
  const user = await requireUser("POLICYHOLDER");
  const policy = await db.policy.findUnique({ where: { id: policyId }, select: { customerId: true } });
  if (!policy || policy.customerId !== user.customerId) throw new Error("Policy not found");
}

export async function startPaymentAction(policyId: string): Promise<StartPaymentResult> {
  await requireOwnPolicy(policyId);
  try {
    return { ok: true, ...(await startPayment(policyId)) };
  } catch (error) {
    if (error instanceof PaymentError || error instanceof StripeNotConfiguredError) {
      return { ok: false, error: error.message };
    }
    console.error(error);
    return { ok: false, error: "We couldn't start the payment. Please try again." };
  }
}

/** Called after the payment form finishes, and while a payment is pending. */
export async function refreshPaymentsAction(policyId: string) {
  await requireOwnPolicy(policyId);
  await reconcilePending(policyId);
  revalidatePath(`/portal/policies/${policyId}`);
}
