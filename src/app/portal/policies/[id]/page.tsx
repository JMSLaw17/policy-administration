import { notFound } from "next/navigation";
import { ClaimsCard } from "@/components/claims/claims-card";
import { PaymentsCard } from "@/components/policy/payments-card";
import { PayCard } from "@/components/portal/pay-card";
import { CoverageCard, DemoNotice, HistoryCard, PolicySummary, StatementCard } from "@/components/policy/policy-sections";
import { BackLink } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { isStripeConfigured } from "@/lib/integrations/stripe";
import { claimsForPolicy } from "@/lib/policies/claims";
import { reconcilePending } from "@/lib/policies/payments";
import { loadPolicyView } from "@/lib/policies/view";

export const metadata = { title: "My policy" };

export default async function PortalPolicyPage(props: PageProps<"/portal/policies/[id]">) {
  const user = await requireUser("POLICYHOLDER");
  const { id } = await props.params;
  // A policyholder can only open their own policies.
  const owner = await db.policy.findUnique({ where: { id }, select: { customerId: true } });
  if (!owner || owner.customerId !== user.customerId) notFound();

  // Backstop for missed webhooks: settle anything Stripe has finished.
  if (isStripeConfigured()) await reconcilePending(id);
  const view = await loadPolicyView(id);
  if (!view) notFound();
  const claims = await claimsForPolicy(id);
  const everCovered = [...new Set(view.statement.flatMap((r) => (r.coverageCode ? [r.coverageCode] : [])))];
  const hasPendingPayment = view.payments.some((p) => p.status === "PENDING");

  return (
    <div className="space-y-6">
      <BackLink href="/portal">My policies</BackLink>
      <PolicySummary view={view} policyBasePath="/portal/policies" />
      <DemoNotice view={view} />
      <PayCard policyId={view.id} amountDueCents={view.balanceCents} hasPendingPayment={hasPendingPayment} dueDate={view.dueDate} />
      <CoverageCard view={view} />
      <StatementCard view={view} />
      <PaymentsCard view={view} />
      <ClaimsCard policyId={view.id} claims={claims} coverageCodes={everCovered} canDecide={false} />
      <HistoryCard view={view} />
    </div>
  );
}
