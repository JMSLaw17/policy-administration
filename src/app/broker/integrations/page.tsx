import { Badge, Card } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata = { title: "Integration log" };

export default async function IntegrationLogPage() {
  await requireUser("BROKER");
  const events = await db.integrationEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { policy: { select: { id: true, policyNumber: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Integration log</h1>
        <p className="mt-1 text-sm text-slate-500">
          Every request this app sent to a sandbox and every webhook it received, newest first.
        </p>
      </div>
      <Card>
        {events.length === 0 ? (
          <p className="px-5 py-4 text-sm text-slate-500">Nothing yet. Events appear here as payments are made.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-2 font-medium">When (UTC)</th>
                <th className="px-5 py-2 font-medium">Service</th>
                <th className="px-5 py-2 font-medium">Direction</th>
                <th className="px-5 py-2 font-medium">Event</th>
                <th className="px-5 py-2 font-medium">Policy</th>
                <th className="px-5 py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="px-5 py-2.5 whitespace-nowrap font-mono text-xs text-slate-600">
                    {e.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="px-5 py-2.5 capitalize text-slate-900">{e.provider}</td>
                  <td className="px-5 py-2.5">
                    {e.direction === "INBOUND" ? <Badge tone="indigo">Received</Badge> : <Badge>Sent</Badge>}
                  </td>
                  <td className="px-5 py-2.5 font-mono text-xs text-slate-900">
                    {e.eventType}
                    {e.externalId && <span className="block text-slate-500">{e.externalId}</span>}
                  </td>
                  <td className="px-5 py-2.5">
                    {e.policy ? (
                      <a className="text-indigo-600 underline" href={`/broker/policies/${e.policy.id}`}>
                        {e.policy.policyNumber}
                      </a>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-5 py-2.5">
                    <details>
                      <summary className="cursor-pointer text-xs text-indigo-600">Payload</summary>
                      <pre className="mt-1 max-w-md overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-700">
                        {JSON.stringify(e.payload, null, 2)}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
