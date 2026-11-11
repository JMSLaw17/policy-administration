"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { DEMO_PASSWORD } from "@/lib/demo";
import { COVERAGES, isISODate, PolicyRuleError } from "@/lib/engine";
import {
  applyChange,
  issuePolicy,
  previewChange,
  type ChangePreview,
  type ChangeRequest,
} from "@/lib/policies/service";

export type FormState = { error?: string } | undefined;

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

/* ------------------------------ Issue ------------------------------ */

const IssueSchema = z.object({
  customerId: z.string().min(1),
  startDate: isoDate,
  coverages: z.array(coverageCode).min(1),
});

export async function issuePolicyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser("BROKER");
  const parsed = IssueSchema.safeParse({
    customerId: formData.get("customerId"),
    startDate: formData.get("startDate"),
    coverages: formData.getAll("coverages"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  let policyId: string;
  try {
    const policy = await issuePolicy({
      customerId: parsed.data.customerId,
      startDate: parsed.data.startDate,
      coverageCodes: parsed.data.coverages,
      userId: user.id,
    });
    policyId = policy.id;
  } catch (error) {
    if (error instanceof PolicyRuleError) return { error: error.message };
    throw error;
  }
  redirect(`/broker/policies/${policyId}`);
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
  | { ok: true; preview: ChangePreview }
  | { ok: false; error: string };

/** Step 1: show the broker what the change will do to the statement. */
export async function previewChangeAction(policyId: string, request: unknown): Promise<ChangeResult> {
  await requireUser("BROKER");
  return run(request, (parsed) => previewChange(policyId, parsed));
}

/** Step 2: save it. */
export async function applyChangeAction(policyId: string, request: unknown): Promise<ChangeResult> {
  const user = await requireUser("BROKER");
  const result = await run(request, async (parsed) => (await applyChange(policyId, parsed, user.id)).preview);
  if (result.ok) {
    revalidatePath(`/broker/policies/${policyId}`);
    revalidatePath(`/portal/policies/${policyId}`);
  }
  return result;
}

async function run(
  request: unknown,
  fn: (parsed: ChangeRequest) => Promise<ChangePreview>,
): Promise<ChangeResult> {
  const parsed = ChangeSchema.safeParse(request);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  try {
    return { ok: true, preview: await fn(parsed.data) };
  } catch (error) {
    if (error instanceof PolicyRuleError) return { ok: false, error: error.message };
    throw error;
  }
}
