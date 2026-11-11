import { notFound } from "next/navigation";
import { CancelCard, CorrectControl, EditCoverageCard } from "@/components/broker/policy-actions";
import { RetryRefundButton } from "@/components/broker/retry-refund";
import { PaymentsCard } from "@/components/policy/payments-card";
import { CoverageCard, HistoryCard, PolicySummary, StatementCard } from "@/components/policy/policy-sections";
import { BackLink } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { todayISO } from "@/lib/engine";
import { isStripeConfigured } from "@/lib/integrations/stripe";
import { reconcilePending } from "@/lib/policies/payments";
import { loadPolicyView } from "@/lib/policies/view";

export const metadata = { title: "Policy" };

export default async function BrokerPolicyPage(props: PageProps<"/broker/policies/[id]">) {
  await requireUser("BROKER");
  const { id } = await props.params;
  // Backstop for missed webhooks: settle anything Stripe has finished.
  if (isStripeConfigured()) await reconcilePending(id);
  const view = await loadPolicyView(id);
  if (!view) notFound();

  const active = view.status === "ACTIVE";
  const today = todayISO();
  // A credit with no refund on its way means a refund failed or Stripe wasn't reachable.
  const stuckCredit = view.balanceCents < 0 && !view.refunds.some((r) => r.status === "PENDING");

  return (
    <div className="space-y-6">
      <BackLink href={`/broker/customers/${view.customer.id}`}>{view.customer.businessName}</BackLink>
      <PolicySummary view={view} />
      <CoverageCard view={view} />
      <StatementCard view={view} />
      <PaymentsCard view={view} actions={stuckCredit ? <RetryRefundButton policyId={view.id} /> : null} />
      <HistoryCard
        view={view}
        renderAction={(entry) =>
          entry.correctable ? (
            <CorrectControl
              // Remount with fresh defaults after each correction.
              key={entry.id}
              policyId={view.id}
              transactionId={entry.id}
              seq={entry.seq}
              event={entry.correctable}
            />
          ) : null
        }
      />
      {active && (
        <>
          <EditCoverageCard
            policyId={view.id}
            coverage={view.coverage}
            startDate={view.startDate}
            endDate={view.endDate}
            today={today}
          />
          <CancelCard policyId={view.id} startDate={view.startDate} endDate={view.endDate} today={today} />
        </>
      )}
    </div>
  );
}
