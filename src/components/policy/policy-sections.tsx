import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import {
  coverageName,
  formatDate,
  formatUSD,
  formulaFor,
  periodFor,
  signedUSD,
  todayISO,
} from "@/lib/engine";
import type { HistoryEntry, PolicyView, StatementRow } from "@/lib/policies/view";

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

/* ------------------------------ Summary ------------------------------ */

export function PolicySummary({
  view,
  actions,
  policyBasePath,
}: {
  view: View;
  actions?: React.ReactNode;
  /** Where policy links go for this role, e.g. "/broker/policies". */
  policyBasePath: string;
}) {
  const due = view.balanceCents;
  return (
    <div className="flex flex-wrap items-start justify-between gap-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{view.policyNumber}</h1>
          {view.status === "ACTIVE" ? <Badge tone="green">Active</Badge> : <Badge tone="red">Cancelled</Badge>}
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Small Business Package for <span className="font-medium">{view.customer.businessName}</span>
        </p>
        <p className="mt-1 text-sm text-slate-500">
          Term: {formatDate(view.startDate)} to {formatDate(view.endDate)} ({view.termDays} days)
          {view.cancelledEffective && <> · Cancelled effective {formatDate(view.cancelledEffective)}</>}
        </p>
        {view.renewedFrom && (
          <p className="mt-1 text-sm text-slate-500">
            Renewal of{" "}
            <Link className="text-indigo-600 underline" href={`${policyBasePath}/${view.renewedFrom.id}`}>
              {view.renewedFrom.policyNumber}
            </Link>
          </p>
        )}
        {view.renewal && (
          <p className="mt-1 text-sm text-slate-500">
            Renewed for the following term as{" "}
            <Link className="text-indigo-600 underline" href={`${policyBasePath}/${view.renewal.id}`}>
              {view.renewal.policyNumber}
            </Link>
          </p>
        )}
        {view.application && (
          <p className="mt-1 text-sm text-slate-500">
            Application signed by {view.application.signerName} on {dateTime(view.application.signedAt)} through
            DocuSign ·{" "}
            <a
              className="text-indigo-600 underline"
              href={`/api/applications/${view.application.id}/document`}
              target="_blank"
              rel="noreferrer"
            >
              View signed application
            </a>
          </p>
        )}
      </div>
      <div className="flex items-center gap-4">
        <div className="text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {due > 0 ? "Amount due" : due < 0 ? "Credit on account" : "Balance"}
          </p>
          <p
            className={`text-2xl font-semibold tabular-nums ${due > 0 ? "text-slate-900" : due < 0 ? "text-green-700" : "text-slate-900"}`}
            data-testid="balance"
          >
            {formatUSD(Math.abs(due))}
          </p>
          {due === 0 && <p className="text-xs text-slate-500">Paid in full</p>}
          {due > 0 && view.dueDate && (
            <p className="text-xs text-slate-500" data-testid="due-date">
              Due by {formatDate(view.dueDate)}, when the term starts
            </p>
          )}
        </div>
        {actions}
      </div>
    </div>
  );
}

/* ------------------------------ Coverage ------------------------------ */

export function CoverageCard({ view }: { view: View }) {
  const today = todayISO();
  return (
    <Card title="Coverage" description="What is covered, and for which days.">
      {view.coverage.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">No coverage is in force.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-5 py-2 font-medium">Coverage</th>
              <th className="px-5 py-2 font-medium">In force</th>
              <th className="px-5 py-2 font-medium">Status</th>
              <th className="px-5 py-2 text-right font-medium">Annual premium</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {view.coverage.map((c) => (
              <tr key={`${c.code}-${c.from}`}>
                <td className="px-5 py-2.5 font-medium text-slate-900">{coverageName(c.code)}</td>
                <td className="px-5 py-2.5 text-slate-600">
                  {formatDate(c.from)} to {formatDate(c.to)}
                </td>
                <td className="px-5 py-2.5">
                  {today < c.from ? (
                    <Badge tone="indigo">Starts {formatDate(c.from)}</Badge>
                  ) : today >= c.to ? (
                    <Badge>Ended</Badge>
                  ) : (
                    <Badge tone="green">In force</Badge>
                  )}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-slate-600">
                  {formatUSD(c.annualPremiumCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/* ------------------------------ Statement ------------------------------ */

const kindLabel: Record<StatementRow["kind"], string> = {
  CHARGE: "Charge",
  CREDIT: "Credit",
  REVERSAL: "Reversal",
  PAYMENT: "Payment",
  REFUND: "Refund",
};

export function StatementCard({ view }: { view: View }) {
  return (
    <Card
      id="statement"
      title="Statement"
      description="Every charge, payment, and refund, oldest first. Open a line to see how it was calculated and where it came from."
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-5 py-2 font-medium">#</th>
            <th className="px-5 py-2 font-medium">Posted</th>
            <th className="px-5 py-2 font-medium">Description</th>
            <th className="px-5 py-2 text-right font-medium">Amount</th>
            <th className="px-5 py-2 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {view.statement.map((row) => (
            <tr key={row.id} id={`line-${row.line}`} className="scroll-mt-6 align-top target:bg-amber-50">
              <td className="px-5 py-3 tabular-nums text-slate-400">{row.line}</td>
              <td className="px-5 py-3 whitespace-nowrap text-slate-600">{dateTime(row.postedAt)}</td>
              <td className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={row.reversedByLine ? "text-slate-500 line-through decoration-slate-400" : "text-slate-900"}>
                    {row.description}
                  </span>
                  <Badge tone={row.kind === "PAYMENT" ? "green" : row.kind === "REVERSAL" ? "amber" : row.kind === "REFUND" ? "indigo" : "slate"}>
                    {kindLabel[row.kind]}
                  </Badge>
                  {row.reversedByLine && (
                    <Badge tone="amber">Superseded by correction #{row.reversedBySeq}</Badge>
                  )}
                </div>
                <details className="mt-1 text-slate-600">
                  <summary className="cursor-pointer text-xs text-indigo-600 hover:text-indigo-500">
                    How was this calculated?
                  </summary>
                  <RowExplanation row={row} />
                </details>
              </td>
              <td className="px-5 py-3 text-right tabular-nums whitespace-nowrap font-medium text-slate-900">
                {signedUSD(row.amountCents)}
              </td>
              <td className="px-5 py-3 text-right tabular-nums whitespace-nowrap text-slate-600">
                {formatUSD(row.balanceAfterCents)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
            <td colSpan={4} className="px-5 py-3 text-right text-slate-700">
              {view.balanceCents < 0
                ? "Credit on account"
                : view.balanceCents > 0 && view.dueDate
                  ? `Amount due by ${formatDate(view.dueDate)}`
                  : "Amount due"}
            </td>
            <td className="px-5 py-3 text-right tabular-nums text-slate-900">
              {formatUSD(Math.abs(view.balanceCents))}
            </td>
          </tr>
        </tfoot>
      </table>
    </Card>
  );
}

function RowExplanation({ row }: { row: StatementRow }) {
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-slate-50 p-3 text-xs">
      {row.calc && row.coverageCode && (
        <>
          <dt className="text-slate-500">Covers</dt>
          <dd>{periodFor({ ...row.calc, coverageCode: row.coverageCode })}</dd>
          <dt className="text-slate-500">Formula</dt>
          <dd>
            annual premium × days ÷ days in term
            <br />
            <span className="font-mono text-slate-900">
              {formulaFor({ ...row.calc, amountCents: row.amountCents })}
            </span>
            {row.kind === "CREDIT" && <> , credited back to you</>}
            {row.kind === "REVERSAL" && <> , with the opposite sign to cancel line {row.reversesLine}</>}
          </dd>
        </>
      )}
      {row.kind === "REVERSAL" && row.reversesLine && (
        <>
          <dt className="text-slate-500">Reverses</dt>
          <dd>
            <a className="text-indigo-600 underline" href={`#line-${row.reversesLine}`}>
              Line {row.reversesLine}
            </a>
            . The original line stays on the statement so you can see what changed.
          </dd>
        </>
      )}
      {row.reversedByLine && (
        <>
          <dt className="text-slate-500">Superseded</dt>
          <dd>
            Cancelled out by{" "}
            <a className="text-indigo-600 underline" href={`#line-${row.reversedByLine}`}>
              line {row.reversedByLine}
            </a>{" "}
            after a correction.
          </dd>
        </>
      )}
      {row.postedBySeq && (
        <>
          <dt className="text-slate-500">Caused by</dt>
          <dd>
            <a className="text-indigo-600 underline" href={`#history-${row.postedBySeq}`}>
              Policy history #{row.postedBySeq}
            </a>
          </dd>
        </>
      )}
      {row.paymentId && (
        <>
          <dt className="text-slate-500">Payment record</dt>
          <dd>
            <a className="text-indigo-600 underline" href={`#payment-${row.paymentId}`}>
              See payment
            </a>
          </dd>
        </>
      )}
      {row.refundId && (
        <>
          <dt className="text-slate-500">Refund record</dt>
          <dd>
            <a className="text-indigo-600 underline" href={`#refund-${row.refundId}`}>
              See refund
            </a>
          </dd>
        </>
      )}
    </dl>
  );
}

/* ------------------------------ History ------------------------------ */

export function HistoryCard({
  view,
  renderAction,
}: {
  view: View;
  /** Lets the broker page add a "Correct" control to each entry. */
  renderAction?: (entry: HistoryEntry) => React.ReactNode;
}) {
  return (
    <Card
      id="history"
      title="Policy history"
      description="Every action taken on this policy. Nothing is ever edited or deleted; mistakes are fixed with a correction."
    >
      <ol className="divide-y divide-slate-100">
        {view.history.map((entry) => (
          <li key={entry.id} id={`history-${entry.seq}`} className="scroll-mt-6 px-5 py-4 target:bg-amber-50">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm tabular-nums text-slate-400">#{entry.seq}</span>
                  <span className={`font-medium ${entry.supersededBySeq ? "text-slate-500" : "text-slate-900"}`}>
                    {entry.title}
                  </span>
                  {entry.supersededBySeq && (
                    <a href={`#history-${entry.supersededBySeq}`}>
                      <Badge tone="amber">Superseded by #{entry.supersededBySeq}</Badge>
                    </a>
                  )}
                  {entry.type === "CORRECTION" && <Badge tone="indigo">Correction</Badge>}
                </div>
                <p className="mt-1 text-sm text-slate-700">{entry.summary}</p>
                {entry.explanation && (
                  <p className="mt-2 rounded-md bg-indigo-50 px-3 py-2 text-sm text-slate-800" data-testid="explanation">
                    <span className="font-medium">What this means: </span>
                    {entry.explanation}
                  </p>
                )}
                {entry.reason && <p className="mt-1 text-sm text-slate-500">Reason: {entry.reason}</p>}
                <p className="mt-1 text-xs text-slate-500">
                  Recorded {dateTime(entry.createdAt)} by {entry.createdBy}
                  {entry.statementLines.length > 0 && (
                    <>
                      {" · Statement "}
                      {entry.statementLines.map((n, i) => (
                        <span key={n}>
                          {i > 0 && ", "}
                          <a className="text-indigo-600 underline" href={`#line-${n}`}>
                            line {n}
                          </a>
                        </span>
                      ))}
                    </>
                  )}
                </p>
              </div>
              {entry.statementLines.length > 0 && (
                <div className="text-right">
                  <p className="text-xs text-slate-500">Change in premium owed</p>
                  <p className="font-medium tabular-nums text-slate-900">{signedUSD(entry.netCents)}</p>
                </div>
              )}
            </div>
            {renderAction?.(entry)}
          </li>
        ))}
      </ol>
    </Card>
  );
}
