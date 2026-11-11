import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata = { title: "My policies" };

export default async function PortalHome() {
  const user = await requireUser("POLICYHOLDER");
  const customer = user.customerId
    ? await db.customer.findUnique({
        where: { id: user.customerId },
        include: { policies: { orderBy: { createdAt: "desc" } } },
      })
    : null;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">My policies</h1>
      <p className="mt-1 text-sm text-slate-500">{customer?.businessName}</p>
      {!customer || customer.policies.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
          You don&apos;t have any policies yet. Your broker will issue one for you.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {customer.policies.map((p) => (
            <li key={p.id} className="px-4 py-3 text-sm">
              {p.policyNumber}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
