import Link from "next/link";
import { notFound } from "next/navigation";
import { BackLink, Badge, Card } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDate, fromJSDate, todayISO } from "@/lib/engine";
import { IssuePolicyForm } from "./issue-policy-form";

export const metadata = { title: "Customer" };

export default async function CustomerPage(props: PageProps<"/broker/customers/[id]">) {
  await requireUser("BROKER");
  const { id } = await props.params;
  const customer = await db.customer.findUnique({
    where: { id },
    include: { policies: { orderBy: { createdAt: "asc" } }, users: { select: { email: true } } },
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
          <p className="px-5 py-4 text-sm text-slate-500">No policies yet. Issue one below.</p>
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
                {p.status === "ACTIVE" ? <Badge tone="green">Active</Badge> : <Badge tone="red">Cancelled</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Issue a policy"
        description="Small Business Package. Flat annual price per coverage; the full-term premium is charged when the policy is issued."
      >
        <IssuePolicyForm customerId={customer.id} today={todayISO()} />
      </Card>
    </div>
  );
}
