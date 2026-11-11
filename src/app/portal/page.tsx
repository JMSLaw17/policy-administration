import Link from "next/link";
import { Badge } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApplicationList } from "@/components/policy/application-list";
import { SignButton } from "@/components/portal/sign-button";
import { Card } from "@/components/ui";
import { formatDate, fromJSDate } from "@/lib/engine";
import { isDocuSignConfigured } from "@/lib/integrations/docusign";
import { syncPendingApplications } from "@/lib/policies/applications";

export const metadata = { title: "My policies" };

export default async function PortalHome() {
  const user = await requireUser("POLICYHOLDER");
  if (user.customerId && isDocuSignConfigured()) await syncPendingApplications(user.customerId);
  const customer = user.customerId
    ? await db.customer.findUnique({
        where: { id: user.customerId },
        include: {
          policies: { orderBy: { createdAt: "desc" } },
          applications: {
            where: { status: { in: ["AWAITING_SIGNATURE", "SIGNED"] } },
            orderBy: { createdAt: "desc" },
            include: { policy: { select: { id: true, policyNumber: true } } },
          },
        },
      })
    : null;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">My policies</h1>
      <p className="mt-1 text-sm text-slate-500">{customer?.businessName}</p>
      {customer && customer.applications.length > 0 && (
        <div className="mt-6">
          <Card
            title="Applications"
            description="Review and sign your application through DocuSign. Your broker issues the policy once it's signed."
          >
            <ApplicationList
              applications={customer.applications}
              policyHref={(policyId) => `/portal/policies/${policyId}`}
              renderAction={(a) =>
                a.status === "AWAITING_SIGNATURE" ? (
                  <SignButton applicationId={a.id} />
                ) : (
                  <span className="text-sm text-slate-500">Waiting for your broker to issue the policy</span>
                )
              }
            />
          </Card>
        </div>
      )}
      {!customer || customer.policies.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
          You don&apos;t have any policies yet. Your broker will issue one for you.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white shadow-sm">
          {customer.policies.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-5 py-3 text-sm">
              <Link href={`/portal/policies/${p.id}`} className="font-medium text-indigo-700 hover:underline">
                {p.policyNumber}
              </Link>
              <span className="text-slate-600">
                {formatDate(fromJSDate(p.startDate))} to {formatDate(fromJSDate(p.endDate))}
              </span>
              {p.status === "ACTIVE" ? <Badge tone="green">Active</Badge> : <Badge tone="red">Cancelled</Badge>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
