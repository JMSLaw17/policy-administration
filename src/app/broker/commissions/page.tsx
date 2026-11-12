import Link from "next/link";
import { Card } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { formatDate, formatRate, formatUSD } from "@/lib/engine";
import { commissionForAllPolicies } from "@/lib/policies/commissions";

export const metadata = { title: "Commissions" };

export default async function CommissionsPage() {
  await requireUser("BROKER");
  const policies = await commissionForAllPolicies();
  const totalPremium = policies.reduce((s, p) => s + p.premiumCents, 0);
  const totalCommission = policies.reduce((s, p) => s + p.commissionCents, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Commissions</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          Commission is a percentage of the premium on each policy, worked out from the premium lines on its
          statement. When premium is credited back after a correction or cancellation, the commission on it is
          clawed back. Open a policy to see the commission on each line.
        </p>
      </div>
      <Card>
        {policies.length === 0 ? (
          <p className="px-5 py-4 text-sm text-slate-500">No policies yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-2 font-medium">Policy</th>
                <th className="px-5 py-2 font-medium">Customer</th>
                <th className="px-5 py-2 font-medium">Term</th>
                <th className="px-5 py-2 text-right font-medium">Rate</th>
                <th className="px-5 py-2 text-right font-medium">Net premium</th>
                <th className="px-5 py-2 text-right font-medium">Commission</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {policies.map((p) => (
                <tr key={p.policyId}>
                  <td className="px-5 py-2.5">
                    <Link className="font-medium text-indigo-700 hover:underline" href={`/broker/policies/${p.policyId}#commission`}>
                      {p.policyNumber}
                    </Link>
                  </td>
                  <td className="px-5 py-2.5 text-slate-700">{p.businessName}</td>
                  <td className="px-5 py-2.5 text-slate-600">
                    <span className="whitespace-nowrap">
                      {formatDate(p.startDate)} to {formatDate(p.endDate)}
                    </span>
                    {p.cancelledEffective && (
                      <span className="block text-xs text-slate-500">Cancelled from {formatDate(p.cancelledEffective)}</span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-right tabular-nums text-slate-600">{formatRate(p.rateBps)}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums text-slate-700">{formatUSD(p.premiumCents)}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums font-medium text-slate-900">
                    {formatUSD(p.commissionCents)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                <td colSpan={4} className="px-5 py-3 text-right text-slate-700">
                  Total
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-slate-900">{formatUSD(totalPremium)}</td>
                <td className="px-5 py-3 text-right tabular-nums text-slate-900">{formatUSD(totalCommission)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>
    </div>
  );
}
