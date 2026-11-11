"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { DEMO_PASSWORD } from "@/lib/demo";
import { COVERAGES, formatUSD, isISODate, PolicyRuleError } from "@/lib/engine";
import { StripeNotConfiguredError } from "@/lib/integrations/stripe";
import { DocuSignError, isDocuSignConfigured } from "@/lib/integrations/docusign";
import { issueFromApplication, sendApplication, withdrawApplication } from "@/lib/policies/applications";
import { updateCustomerDetails } from "@/lib/policies/details";
import { refundCredit } from "@/lib/policies/payments";
import { renewPolicy } from "@/lib/policies/renewals";
import {
  applyChange,
  issuePolicy,
  previewChange,
  type ChangePreview,
  type ChangeRequest,
} from "@/lib/policies/service";

export type FormState = { error?: string; saved?: string } | undefined;

const isoDate = z.string().refine(isISODate, "Enter a valid date.");
const coverageCode = z.enum(COVERAGES.map((c) => c.code) as [string, ...string[]]);

/* ---------------------------- Customers ---------------------------- */

const CustomerSchema = z.object({
  businessName: z.string().trim().min(1, "Enter the business name."),
  contactName: z.string().trim().min(1, "Enter a contact name."),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  addressLine1: z.string().trim().min(1, "Enter the street address."),
  city: z.string().trim().min(1, "Enter the city."),
  state: z.string().trim().toUpperCase().length(2, "Use the two-letter state code."),
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Enter a 5-digit ZIP code."),
});

export async function createCustomer(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser("BROKER");
  const parsed = CustomerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const taken = await db.user.findUnique({ where: { email: parsed.data.email } });
  if (taken) return { error: "A login with that email already exists." };

  // Demo convenience: every new customer gets a policyholder login with the
  // shared demo password, so reviewers can sign in as them straight away.
  const customer = await db.customer.create({
    data: {
      ...parsed.data,
      users: {
        create: {
          email: parsed.data.email,
          name: parsed.data.contactName,
          role: "POLICYHOLDER",
          passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10),
        },
      },
    },
  });
  redirect(`/broker/customers/${customer.id}`);
}

export type DetailsState = { error?: string; saved?: string } | undefined;

export async function updateCustomerAction(_prev: DetailsState, formData: FormData): Promise<DetailsState> {
  const user = await requireUser("BROKER");
  const customerId = String(formData.get("customerId") ?? "");
  const parsed = CustomerSchema.safeParse(Object.fromEntries(formData));
  if (!customerId || !parsed.success) {
    return { error: parsed.success ? "Customer not found." : parsed.error.issues[0].message };
  }
  const { changed } = await updateCustomerDetails(customerId, parsed.data, user.id);
  revalidatePath(`/broker/customers/${customerId}`);
  return {
    saved:
      changed === 0
        ? "Nothing changed."
        : "Saved. The change is recorded in the history of each of this customer's policies.",
  };
}

/* ------------------------------ Issue ------------------------------ */

const IssueSchema = z.object({
  customerId: z.string().min(1),
  startDate: isoDate,
  coverages: z.array(coverageCode).min(1),
});

/**
 * With DocuSign set up, this sends an application for the policyholder to
 * sign, and the policy is issued afterwards from the signed application.
 * Without DocuSign (local development with no keys) it issues straight away.
 */
export async function issuePolicyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("BROKER");
  const parsed = IssueSchema.safeParse({
    customerId: formData.get("customerId"),
    startDate: formData.get("startDate"),
    coverages: formData.getAll("coverages"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const input = {
    customerId: parsed.data.customerId,
    startDate: parsed.data.startDate,
    coverageCodes: parsed.data.coverages,
    userId: user.id,
  };

  let policyId: string;
  try {
    if (isDocuSignConfigured()) {
      await sendApplication(input);
      revalidatePath(`/broker/customers/${input.customerId}`);
      return { saved: "Application sent. The policyholder can now sign it from their account." };
    }
    policyId = (await issuePolicy(input)).id;
  } catch (error) {
    if (error instanceof PolicyRuleError || error instanceof DocuSignError) return { error: error.message };
    throw error;
  }
  redirect(`/broker/policies/${policyId}`);
}

export async function issueFromApplicationAction(applicationId: string): Promise<FormState> {
  const user = await requireUser("BROKER");
  let policyId: string;
  try {
    policyId = (await issueFromApplication(applicationId, user.id)).id;
  } catch (error) {
    if (error instanceof PolicyRuleError || error instanceof DocuSignError) return { error: error.message };
    throw error;
  }
  redirect(`/broker/policies/${policyId}`);
}

export async function withdrawApplicationAction(applicationId: string, customerId: string): Promise<FormState> {
  await requireUser("BROKER");
  try {
    await withdrawApplication(applicationId);
  } catch (error) {
    if (error instanceof PolicyRuleError || error instanceof DocuSignError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/broker/customers/${customerId}`);
}

/* ------------------- Edit coverage, correct, cancel ------------------- */

const reason = z.string().trim().max(500).optional();
const ChangeSchema: z.ZodType<ChangeRequest> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("COVERAGE_CHANGE"),
    effectiveDate: isoDate,
    add: z.array(coverageCode),
    remove: z.array(coverageCode),
    reason,
  }),
  z.object({ kind: z.literal("CANCELLATION"), effectiveDate: isoDate, reason }),
  z.object({
    kind: z.literal("CORRECTION"),
    transactionId: z.string().min(1),
    reason,
    event: z.discriminatedUnion("type", [
      z.object({ type: z.literal("ISSUE"), startDate: isoDate, coverages: z.array(coverageCode) }),
      z.object({
        type: z.literal("COVERAGE_CHANGE"),
        effectiveDate: isoDate,
        add: z.array(coverageCode),
        remove: z.array(coverageCode),
      }),
      z.object({ type: z.literal("CANCELLATION"), effectiveDate: isoDate }),
    ]),
  }),
]);

export type ChangeResult =
  | { ok: true; preview: ChangePreview; notice?: string }
  | { ok: false; error: string };

/** Step 1: show the broker what the change will do to the statement. */
export async function previewChangeAction(policyId: string, request: unknown): Promise<ChangeResult> {
  await requireUser("BROKER");
  const parsed = ChangeSchema.safeParse(request);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  try {
    return { ok: true, preview: await previewChange(policyId, parsed.data) };
  } catch (error) {
    if (error instanceof PolicyRuleError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Step 2: save it, then refund any credit it leaves the customer with. */
export async function applyChangeAction(policyId: string, request: unknown): Promise<ChangeResult> {
  const user = await requireUser("BROKER");
  const parsed = ChangeSchema.safeParse(request);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };

  let result: Awaited<ReturnType<typeof applyChange>>;
  try {
    result = await applyChange(policyId, parsed.data, user.id);
  } catch (error) {
    if (error instanceof PolicyRuleError) return { ok: false, error: error.message };
    throw error;
  }

  // The change is saved. If it left a credit, send it back to the card.
  const notice = await settleCredit(policyId, result.transaction.id);
  revalidatePolicy(policyId);
  return { ok: true, preview: result.preview, notice };
}

/** Lets the broker re-send a refund that failed. */
export async function retryRefundAction(policyId: string): Promise<{ notice?: string }> {
  await requireUser("BROKER");
  const notice = await settleCredit(policyId);
  revalidatePolicy(policyId);
  return { notice };
}

async function settleCredit(policyId: string, transactionId?: string): Promise<string | undefined> {
  try {
    const { refundedCents, message } = await refundCredit(policyId, transactionId);
    if (message) return message;
    if (refundedCents > 0) return `${formatUSD(refundedCents)} was refunded to the customer's card.`;
  } catch (error) {
    if (error instanceof StripeNotConfiguredError) {
      return "The customer has a credit, but Stripe isn't set up here, so it wasn't refunded.";
    }
    console.error(error);
    return "The change was saved, but the refund couldn't be sent. Use Retry refund on the policy page.";
  }
}

function revalidatePolicy(policyId: string) {
  revalidatePath(`/broker/policies/${policyId}`);
  revalidatePath(`/portal/policies/${policyId}`);
}

/* ------------------------------ Renew ------------------------------ */

export async function renewPolicyAction(policyId: string): Promise<FormState> {
  const user = await requireUser("BROKER");
  let renewalId: string;
  try {
    renewalId = (await renewPolicy(policyId, user.id)).id;
  } catch (error) {
    if (error instanceof PolicyRuleError) return { error: error.message };
    throw error;
  }
  revalidatePolicy(policyId);
  redirect(`/broker/policies/${renewalId}`);
}
