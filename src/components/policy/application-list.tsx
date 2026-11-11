import Link from "next/link";
import { Badge } from "@/components/ui";
import { addOneYear, coverageName, formatDate, formatUSD, fromJSDate } from "@/lib/engine";

export type ApplicationRow = {
  id: string;
  startDate: Date;
  coverageCodes: string[];
  premiumCents: number;
  status: "AWAITING_SIGNATURE" | "SIGNED" | "ISSUED" | "VOIDED";
  signerName: string;
  signedAt: Date | null;
  docusignEnvelopeId: string | null;
  policy: { id: string; policyNumber: string } | null;
};

const dateTime = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);

export function ApplicationList({
  applications,
  policyHref,
  renderAction,
}: {
  applications: ApplicationRow[];
  policyHref: (policyId: string) => string;
  renderAction?: (application: ApplicationRow) => React.ReactNode;
}) {
  return (
    <ul className="divide-y divide-slate-100">
      {applications.map((a) => {
        const start = fromJSDate(a.startDate);
        return (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-3 text-sm">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-900">{a.coverageCodes.map(coverageName).join(", ")}</span>
                {a.status === "AWAITING_SIGNATURE" && <Badge tone="amber">Awaiting signature</Badge>}
                {a.status === "SIGNED" && <Badge tone="green">Signed</Badge>}
                {a.status === "ISSUED" && <Badge tone="indigo">Policy issued</Badge>}
                {a.status === "VOIDED" && <Badge>Withdrawn or declined</Badge>}
              </div>
              <p className="mt-0.5 text-slate-600">
                {formatDate(start)} to {formatDate(addOneYear(start))} · {formatUSD(a.premiumCents)} for the term
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {a.signedAt ? (
                  <>
                    Signed by {a.signerName} on {dateTime(a.signedAt)} through DocuSign ·{" "}
                    <a
                      className="text-indigo-600 underline"
                      href={`/api/applications/${a.id}/document`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View signed application
                    </a>
                  </>
                ) : (
                  <>To be signed by {a.signerName}</>
                )}
                {a.docusignEnvelopeId && <span className="font-mono"> · envelope {a.docusignEnvelopeId.slice(0, 8)}</span>}
                {a.policy && (
                  <>
                    {" · "}
                    <Link className="text-indigo-600 underline" href={policyHref(a.policy.id)}>
                      {a.policy.policyNumber}
                    </Link>
                  </>
                )}
              </p>
            </div>
            {renderAction?.(a)}
          </li>
        );
      })}
    </ul>
  );
}
