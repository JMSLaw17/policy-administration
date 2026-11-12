import { Badge, Card } from "@/components/ui";
import { formatUSD } from "@/lib/engine";
import type { PolicyView } from "@/lib/policies/view";

type View = NonNullable<PolicyView>;

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

function StatusBadge({ status }: { status: "INITIATED" | "PENDING" | "SUCCEEDED" | "FAILED" }) {
  if (status === "INITIATED") return <Badge>Not submitted</Badge>;
  if (status === "SUCCEEDED") return <Badge tone="green">Succeeded</Badge>;
  if (status === "FAILED") return <Badge tone="red">Failed</Badge>;
  return <Badge tone="amber">Pending</Badge>;
}

export function PaymentsCard({ view, actions }: { view: View; actions?: React.ReactNode }) {
  const empty = view.payments.length === 0 && view.refunds.length === 0;
  return (
    <Card
      id="payments"
      title="Payments and refunds"
      description="Each record below comes from Stripe. A payment or refund reaches the statement only once Stripe confirms it."
      actions={actions}
    >
      {empty ? (
        <p className="px-5 py-4 text-sm text-slate-500">No payments yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-5 py-2 font-medium">Started</th>
              <th className="px-5 py-2 font-medium">Type</th>
              <th className="px-5 py-2 font-medium">Status</th>
              <th className="px-5 py-2 font-medium">Stripe reference</th>
              <th className="px-5 py-2 font-medium">Statement</th>
              <th className="px-5 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {view.payments.map((p) => (
              <tr key={p.id} id={`payment-${p.id}`} className="scroll-mt-6 align-top target:bg-amber-50">
                <td className="px-5 py-2.5 whitespace-nowrap text-slate-600">{dateTime(p.createdAt)}</td>
                <td className="px-5 py-2.5 text-slate-900">Payment</td>
                <td className="px-5 py-2.5">
                  <StatusBadge status={p.status} />
                  {p.failureReason && <p className="mt-1 text-xs text-red-700">{p.failureReason}</p>}
                  {p.returnedCents > 0 && p.status === "SUCCEEDED" && (
                    <p className="mt-1 text-xs text-red-700">{formatUSD(p.returnedCents)} was later returned by the bank.</p>
                  )}
                </td>
                <td className="px-5 py-2.5 font-mono text-xs text-slate-600">{p.stripePaymentIntentId ?? "—"}</td>
                <td className="px-5 py-2.5">
                  {p.statementLine ? (
                    <a className="text-indigo-600 underline" href={`#line-${p.statementLine}`}>
                      Line {p.statementLine}
                    </a>
                  ) : (
                    <span className="text-slate-400">Not posted</span>
                  )}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-slate-900">{formatUSD(p.amountCents)}</td>
              </tr>
            ))}
            {view.refunds.map((r) => (
              <tr key={r.id} id={`refund-${r.id}`} className="scroll-mt-6 align-top target:bg-amber-50">
                <td className="px-5 py-2.5 whitespace-nowrap text-slate-600">{dateTime(r.createdAt)}</td>
                <td className="px-5 py-2.5 text-slate-900">
                  Refund of{" "}
                  <a className="text-indigo-600 underline" href={`#payment-${r.paymentId}`}>
                    payment
                  </a>
                </td>
                <td className="px-5 py-2.5">
                  <StatusBadge status={r.status} />
                  {r.failureReason && <p className="mt-1 text-xs text-red-700">{r.failureReason}</p>}
                </td>
                <td className="px-5 py-2.5 font-mono text-xs text-slate-600">{r.stripeRefundId ?? "—"}</td>
                <td className="px-5 py-2.5">
                  {r.statementLine ? (
                    <a className="text-indigo-600 underline" href={`#line-${r.statementLine}`}>
                      Line {r.statementLine}
                    </a>
                  ) : (
                    <span className="text-slate-400">Not posted</span>
                  )}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-slate-900">{formatUSD(r.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
