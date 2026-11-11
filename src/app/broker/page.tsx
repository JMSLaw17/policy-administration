import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata = { title: "Customers" };

export default async function BrokerHome() {
  await requireUser("BROKER");
  const customers = await db.customer.findMany({
    orderBy: { businessName: "asc" },
    include: { _count: { select: { policies: true } } },
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Customers</h1>
      <ul className="mt-6 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {customers.map((c) => (
          <li key={c.id} className="flex items-center justify-between px-4 py-3 text-sm">
            <div>
              <p className="font-medium text-slate-900">{c.businessName}</p>
              <p className="text-slate-500">
                {c.contactName} · {c.email}
              </p>
            </div>
            <span className="text-slate-500">
              {c._count.policies} {c._count.policies === 1 ? "policy" : "policies"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
