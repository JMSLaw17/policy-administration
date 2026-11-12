import { DecideClaimForm, FileClaimForm, PayClaimButton } from "./claim-forms";
import { Badge, Card } from "@/components/ui";
import { CLAIM_DEDUCTIBLE_CENTS, coverageName, formatDate, formatUSD, todayISO } from "@/lib/engine";
import type { ClaimView } from "@/lib/policies/claims";

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

const badge = {
  SUBMITTED: <Badge tone="amber">Under review</Badge>,
  APPROVED: <Badge tone="indigo">Approved, awaiting payment</Badge>,
  PAID: <Badge tone="green">Paid</Badge>,
  DENIED: <Badge tone="red">Denied</Badge>,
} as const;

export function ClaimsCard({
  policyId,
  claims,
  coverageCodes,
  canDecide,
  unpaidPremiumCents = 0,
}: {
  policyId: string;
  claims: ClaimView[];
  coverageCodes: string[];
  /** True for the broker, who approves, denies, and pays. */
  canDecide: boolean;
  /** Premium still owed on the policy, shown to the broker as context for a decision. */
  unpaidPremiumCents?: number;
}) {
  return (
    <Card
      id="claims"
      title="Claims"
      description={`A loss is covered if its coverage was in force on the date of loss. An approved claim pays the approved loss less a ${formatUSD(CLAIM_DEDUCTIBLE_CENTS)} deductible, up to the coverage limit. Claim payments are separate from your premium statement.`}
    >
      {canDecide && unpaidPremiumCents > 0 && (
        <p className="mx-5 mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="unpaid-premium-note">
          {formatUSD(unpaidPremiumCents)} of premium is unpaid on this policy. Cover stays in force until the policy
          is cancelled, so a claim can still be approved. Unpaid premium isn&apos;t deducted from a claim payment.
        </p>
      )}
      {claims.length === 0 ? (
        <p className="px-5 pt-4 text-sm text-slate-500">No claims have been filed on this policy.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {claims.map((c) => (
            <li key={c.id} id={`claim-${c.claimNumber}`} className="px-5 py-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900">{c.claimNumber}</span>
                    {c.status === "APPROVED" && c.payoutCents === 0 ? (
                      <Badge>Approved, nothing payable (loss is within the deductible)</Badge>
                    ) : (
                      badge[c.status]
                    )}
                    {!c.stillCovered && c.status !== "DENIED" && (
                      <Badge tone="red">Coverage no longer in force on the loss date</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-slate-700">
                    {coverageName(c.coverageCode)} · loss on {formatDate(c.lossDate)} · {c.description}
                  </p>
                  <ol className="mt-2 space-y-0.5 text-xs text-slate-500">
                    <li>
                      Filed {dateTime(c.filedAt)} by {c.filedBy}, claiming {formatUSD(c.claimedCents)}
                    </li>
                    {c.decidedAt && (
                      <li>
                        {c.status === "DENIED" ? "Denied" : "Approved"} {dateTime(c.decidedAt)} by {c.decidedBy}
                        {c.decisionNote && <>: {c.decisionNote}</>}
                      </li>
                    )}
                    {c.paidAt && <li>Payment recorded {dateTime(c.paidAt)} (simulated, no money moves)</li>}
                  </ol>
                  {c.payoutCents !== null && c.approvedLossCents !== null && c.deductibleCents !== null && (
                    <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">
                      <span className="font-medium">How the payout was calculated: </span>
                      <span className="font-mono">
                        {formatUSD(c.approvedLossCents)} approved loss − {formatUSD(c.deductibleCents)} deductible ={" "}
                        {formatUSD(Math.max(c.approvedLossCents - c.deductibleCents, 0))}
                      </span>
                      {c.limitCents !== null && c.approvedLossCents - c.deductibleCents > c.limitCents
                        ? `, capped at the ${formatUSD(c.limitCents)} limit`
                        : c.limitCents !== null && ` (limit ${formatUSD(c.limitCents)})`}
                    </p>
                  )}
                  {canDecide && c.status === "SUBMITTED" && (
                    <DecideClaimForm
                      claimId={c.id}
                      claimedCents={c.claimedCents}
                      deductibleCents={CLAIM_DEDUCTIBLE_CENTS}
                    />
                  )}
                  {canDecide && c.status === "APPROVED" && c.payoutCents !== null && c.payoutCents > 0 && (
                    <PayClaimButton claimId={c.id} payoutCents={c.payoutCents} />
                  )}
                </div>
                {c.payoutCents !== null && (
                  <div className="text-right">
                    <p className="text-xs text-slate-500">{c.status === "PAID" ? "Paid" : "Payout"}</p>
                    <p className="font-medium tabular-nums text-slate-900">{formatUSD(c.payoutCents)}</p>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <FileClaimForm policyId={policyId} coverageCodes={coverageCodes} today={todayISO()} />
    </Card>
  );
}
