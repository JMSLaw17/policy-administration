import { notFound } from "next/navigation";
import { CoverageCard, HistoryCard, PolicySummary, StatementCard } from "@/components/policy/policy-sections";
import { BackLink } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { loadPolicyView } from "@/lib/policies/view";

export const metadata = { title: "My policy" };

export default async function PortalPolicyPage(props: PageProps<"/portal/policies/[id]">) {
  const user = await requireUser("POLICYHOLDER");
  const { id } = await props.params;
  const view = await loadPolicyView(id);
  // A policyholder can only open their own policies.
  if (!view || view.customer.id !== user.customerId) notFound();

  return (
    <div className="space-y-6">
      <BackLink href="/portal">My policies</BackLink>
      <PolicySummary view={view} />
      <CoverageCard view={view} />
      <StatementCard view={view} />
      <HistoryCard view={view} />
    </div>
  );
}
