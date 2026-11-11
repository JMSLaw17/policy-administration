import Link from "next/link";
import { RenewButton } from "./renew-button";
import { Card } from "@/components/ui";
import { coverageName, formatDate, formatRate, formatUSD, signedUSD } from "@/lib/engine";
import type { PolicyCommission } from "@/lib/policies/commissions";
import type { RenewalPreview } from "@/lib/policies/renewals";

/* ------------------------------ Renewal ------------------------------ */

export function RenewalCard({ policyId, preview }: { policyId: string; preview: RenewalPreview }) {
  return (
    <Card
      id="renew"
      title="Renew policy"
      description="Creates a new policy for the next 12 months with the coverages in force when this term ends, at today's rates. It gets its own number, statement, and payments."
    >
      <div className="px-5 py-4">
        <p className="text-sm text-slate-700">
          New term: {formatDate(preview.startDate)} to {formatDate(preview.endDate)}
        </p>
        <table className="mt-2 w-full max-w-lg text-sm">
          <tbody className="divide-y divide-slate-100">
            {preview.coverages.map((c) => (
              <tr key={c.code}>
                <td className="py-1.5 text-slate-900">{coverageName(c.code)}</td>
                <td className="py-1.5 text-right tabular-nums text-slate-700">
                  {formatUSD(c.annualPremiumCents)}
                  {c.annualPremiumCents !== c.previousAnnualPremiumCents && (
                    <span className="ml-2 text-xs text-slate-500">was {formatUSD(c.previousAnnualPremiumCents)}</span>
                  )}
                </td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="py-1.5 text-slate-900">Premium for the renewal term</td>
              <td className="py-1.5 text-right tabular-nums text-slate-900" data-testid="renewal-premium">
                {formatUSD(preview.premiumCents)}
              </td>
            </tr>
          </tbody>
        </table>
        <div className="mt-4">
          <RenewButton policyId={policyId} />
        </div>
      </div>
    </Card>
  );
}

/* ----------------------------- Commission ----------------------------- */

export function CommissionCard({ commission }: { commission: PolicyCommission }) {
  return (
    <Card
      id="commission"
      title="Broker commission"
      description={`${formatRate(commission.rateBps)} of premium, line by line. Returned premium claws its commission back. Only the broker sees this.`}
    >
      <CommissionTable commission={commission} />
    </Card>
  );
}

export function CommissionTable({ commission }: { commission: PolicyCommission }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <th className="px-5 py-2 font-medium">Statement line</th>
          <th className="px-5 py-2 font-medium">Premium line</th>
          <th className="px-5 py-2 text-right font-medium">Premium</th>
          <th className="px-5 py-2 text-right font-medium">Commission at {formatRate(commission.rateBps)}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {commission.lines.map((l) => (
          <tr key={l.entryId}>
            <td className="px-5 py-2">
              <Link
                className="text-indigo-600 underline"
                href={`/broker/policies/${commission.policyId}#line-${l.statementLine}`}
              >
                Line {l.statementLine}
              </Link>
            </td>
            <td className="px-5 py-2 text-slate-700">{l.description}</td>
            <td className="px-5 py-2 text-right tabular-nums text-slate-700">{signedUSD(l.premiumCents)}</td>
            <td className="px-5 py-2 text-right tabular-nums font-medium text-slate-900">
              {signedUSD(l.commissionCents)}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
          <td colSpan={2} className="px-5 py-2.5 text-right text-slate-700">
            Total
          </td>
          <td className="px-5 py-2.5 text-right tabular-nums text-slate-900">{formatUSD(commission.premiumCents)}</td>
          <td className="px-5 py-2.5 text-right tabular-nums text-slate-900" data-testid="commission-total">
            {formatUSD(commission.commissionCents)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
