import Link from "next/link";
import { DemoScenarioCard } from "@/components/broker/demo-scenario-card";
import { primaryButton } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata = { title: "Customers" };

// Loading the demo scenario makes two Stripe payments, which takes a few seconds.
export const maxDuration = 60;

export default async function BrokerHome() {
  await requireUser("BROKER");
  const customers = await db.customer.findMany({
    orderBy: { businessName: "asc" },
    include: { policies: { select: { id: true, policyNumber: true, status: true }, orderBy: { createdAt: "asc" } } },
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Customers</h1>
        <Link href="/broker/customers/new" className={primaryButton}>
          New customer
        </Link>
      </div>
      <DemoScenarioCard />
      <ul className="mt-6 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white shadow-sm">
        {customers.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
            <div>
              <Link href={`/broker/customers/${c.id}`} className="font-medium text-indigo-700 hover:underline">
                {c.businessName}
              </Link>
              <p className="text-slate-500">
                {c.contactName} · {c.email}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {c.policies.length === 0 && <span className="text-slate-400">No policies yet</span>}
              {c.policies.map((p) => (
                <Link
                  key={p.id}
                  href={`/broker/policies/${p.id}`}
                  className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  {p.policyNumber}
                  {p.status === "CANCELLED" && <span className="ml-1 text-red-600">(cancelled)</span>}
                </Link>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
