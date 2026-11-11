import "server-only";
import { db } from "@/lib/db";
import { todayISO, toJSDate } from "@/lib/engine";

export type CustomerDetails = {
  businessName: string;
  contactName: string;
  email: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
};

const LABELS: Record<keyof CustomerDetails, string> = {
  businessName: "Business name",
  contactName: "Contact name",
  email: "Contact email",
  addressLine1: "Street address",
  city: "City",
  state: "State",
  postalCode: "ZIP code",
};

/**
 * Updates a customer's details. These don't affect any amount, so the record
 * is edited directly, but every change is written to the history of each of
 * the customer's policies: what changed, from what, to what, by whom.
 */
export async function updateCustomerDetails(customerId: string, next: CustomerDetails, userId: string) {
  return db.$transaction(async (tx) => {
    const current = await tx.customer.findUniqueOrThrow({
      where: { id: customerId },
      include: { policies: { select: { id: true } } },
    });
    const changedKeys = (Object.keys(LABELS) as (keyof CustomerDetails)[]).filter(
      (key) => current[key] !== next[key],
    );
    const changes = changedKeys.map((key) => ({ field: LABELS[key], from: current[key], to: next[key] }));
    if (changes.length === 0) return { changed: 0 };

    // Write only the fields this function owns, whatever else the caller passed.
    const data = Object.fromEntries(changes.map((c, i) => [changedKeys[i], c.to]));
    await tx.customer.update({ where: { id: customerId }, data });
    for (const policy of current.policies) {
      await tx.$queryRaw`SELECT id FROM "Policy" WHERE id = ${policy.id} FOR UPDATE`;
      const last = await tx.policyTransaction.aggregate({ where: { policyId: policy.id }, _max: { seq: true } });
      await tx.policyTransaction.create({
        data: {
          policyId: policy.id,
          seq: (last._max.seq ?? 0) + 1,
          type: "DETAILS_CHANGE",
          effectiveDate: toJSDate(todayISO()),
          data: { changes },
          createdById: userId,
        },
      });
    }
    return { changed: changes.length };
  });
}
