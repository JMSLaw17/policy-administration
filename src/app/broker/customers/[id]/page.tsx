import Link from "next/link";
import { notFound } from "next/navigation";
import { BackLink, Card, PolicyStatus } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDate, fromJSDate, todayISO } from "@/lib/engine";
import { ApplicationActions } from "@/components/broker/application-actions";
import { ApplicationList } from "@/components/policy/application-list";
import { isDocuSignConfigured } from "@/lib/integrations/docusign";
import { syncPendingApplications } from "@/lib/policies/applications";
import { EditDetailsForm } from "./edit-details-form";
import { IssuePolicyForm } from "./issue-policy-form";

export const metadata = { title: "Customer" };

export default async function CustomerPage(props: PageProps<"/broker/customers/[id]">) {
  await requireUser("BROKER");
  const { id } = await props.params;
  const requiresSignature = isDocuSignConfigured();
  // Backstop for missed webhooks: pick up anything signed since we last looked.
  if (requiresSignature) await syncPendingApplications(id);
  const customer = await db.customer.findUnique({
    where: { id },
    include: {
      policies: { orderBy: { createdAt: "asc" } },
      users: { select: { email: true } },
      applications: {
        orderBy: { createdAt: "desc" },
        include: { policy: { select: { id: true, policyNumber: true } } },
      },
    },
  });
  if (!customer) notFound();

  return (
    <div className="space-y-6">
      <BackLink href="/broker">Customers</BackLink>
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{customer.businessName}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {customer.contactName} · {customer.email}
        </p>
        <p className="text-sm text-slate-500">
          {customer.addressLine1}, {customer.city}, {customer.state} {customer.postalCode}
        </p>
        {customer.users.length > 0 && (
          <p className="mt-1 text-xs text-slate-500">
            Policyholder login: {customer.users.map((u) => u.email).join(", ")} (demo password, see README)
          </p>
        )}
      </div>

      <Card title="Policies">
        {customer.policies.length === 0 ? (
          <p className="px-5 py-4 text-sm text-slate-500">No policies yet. Start one below.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {customer.policies.map((p) => (
              <li key={p.id} className="flex items-center justify-between px-5 py-3 text-sm">
                <Link href={`/broker/policies/${p.id}`} className="font-medium text-indigo-700 hover:underline">
                  {p.policyNumber}
                </Link>
                <span className="text-slate-600">
                  {formatDate(fromJSDate(p.startDate))} to {formatDate(fromJSDate(p.endDate))}
                </span>
                <PolicyStatus startDate={p.startDate} endDate={p.endDate} cancelledEffective={p.cancelledEffective} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {customer.applications.length > 0 && (
        <Card
          title="Applications"
          description="The policyholder signs the application through DocuSign. Once it's signed, you can issue the policy."
        >
          <ApplicationList
            applications={customer.applications}
            policyHref={(policyId) => `/broker/policies/${policyId}`}
            renderAction={(a) =>
              a.status === "AWAITING_SIGNATURE" || a.status === "SIGNED" ? (
                <ApplicationActions applicationId={a.id} customerId={customer.id} status={a.status} />
              ) : null
            }
          />
        </Card>
      )}

      <Card title="Edit details" description="Business name, contact, and address.">
        <EditDetailsForm
          customerId={customer.id}
          details={{
            businessName: customer.businessName,
            contactName: customer.contactName,
            email: customer.email,
            addressLine1: customer.addressLine1,
            city: customer.city,
            state: customer.state,
            postalCode: customer.postalCode,
          }}
        />
      </Card>

      <Card
        title={requiresSignature ? "Start a new policy" : "Issue a policy"}
        description={
          requiresSignature
            ? "Small Business Package. Flat annual price per coverage. The policyholder signs the application first; the full-term premium is charged when you issue the policy."
            : "Small Business Package. Flat annual price per coverage; the full-term premium is charged when the policy is issued."
        }
      >
        <IssuePolicyForm customerId={customer.id} today={todayISO()} requiresSignature={requiresSignature} />
      </Card>
    </div>
  );
}
